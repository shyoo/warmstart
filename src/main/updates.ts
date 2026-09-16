import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AppUpdateState, UpdatePhase } from '@shared/ipc.js'

export type { UpdatePhase }
export type UpdateState = AppUpdateState

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface GitHubRelease {
  tag_name: string
  draft: boolean
  prerelease: boolean
  assets: ReleaseAsset[]
}

/** A conservative semver comparison: an unfamiliar tag is never treated as an update. */
export function parseVersion(raw: string): readonly [number, number, number] | null {
  const found = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(raw.trim())
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null
}

/** `0.1.0-rc.1` is a pre-release; `0.1.0` and `0.1.0+build` are not. */
function isPrerelease(raw: string): boolean {
  return /^v?\d+\.\d+\.\d+-/.test(raw.trim())
}

/**
 * Only the numeric triple is ordered. The one pre-release rule: the bare version is newer than any
 * pre-release of the same triple, so an installed `-rc` sees the final it was rehearsing. Two
 * pre-releases of one triple are never ordered — GitHub's `latest` never serves one anyway.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate)
  const installed = parseVersion(current)
  if (!next || !installed) return false
  for (let i = 0; i < next.length; i++) {
    if (next[i]! !== installed[i]!) return next[i]! > installed[i]!
  }
  return isPrerelease(current) && !isPrerelease(candidate)
}

function platformName(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'win'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return 'linux'
  return null
}

function extensionsFor(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') return ['.exe']
  if (platform === 'darwin') return ['.dmg']
  if (platform === 'linux') return ['.AppImage', '.deb']
  return []
}

/**
 * Pick only the exact artifact name this repository's electron-builder configuration emits. A
 * release asset that merely happens to be executable is not an update package for this app.
 */
export function selectReleaseAsset(
  assets: readonly ReleaseAsset[],
  version: string,
  platform: NodeJS.Platform,
  arch: string
): ReleaseAsset | null {
  const target = platformName(platform)
  if (!target) return null
  const prefix = `warmstart-${version}-${target}-${arch}`.toLowerCase()
  for (const extension of extensionsFor(platform)) {
    const asset = assets.find((candidate) => candidate.name.toLowerCase() === `${prefix}${extension}`.toLowerCase())
    if (asset) return asset
  }
  return null
}

/** GitHub's checksum asset is `sha256  filename` (with an optional binary-mode `*`). */
export function checksumForAsset(text: string, assetName: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Fa-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())
    if (match?.[2] === assetName) return match[1]!.toLowerCase()
  }
  return null
}

function initialState(currentVersion: string): UpdateState {
  return {
    phase: 'idle', currentVersion, version: null, assetName: null,
    downloadedBytes: 0, totalBytes: null, message: null
  }
}

function asRelease(value: unknown): GitHubRelease | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Partial<GitHubRelease>
  if (typeof record.tag_name !== 'string' || !Array.isArray(record.assets)) return null
  const assets = record.assets.filter(
    (asset): asset is ReleaseAsset =>
      !!asset && typeof asset.name === 'string' && typeof asset.browser_download_url === 'string' && typeof asset.size === 'number'
  )
  return { tag_name: record.tag_name, draft: record.draft === true, prerelease: record.prerelease === true, assets }
}

/**
 * Polls a public GitHub Release and saves a checksum-verified installer. It deliberately never
 * launches that installer: downloading is automatic, replacement of the app remains a person's
 * decision. All fetched bytes stay under the app data directory and are never loaded as code.
 */
export class UpdateManager {
  private state: UpdateState
  private downloadPath: string | null = null

  constructor(
    private readonly options: {
      currentVersion: string
      repository: string
      dataDir: string
      platform?: NodeJS.Platform
      arch?: string
      fetch?: typeof fetch
      onState?: (state: UpdateState) => void
    }
  ) {
    this.state = initialState(options.currentVersion)
  }

  getState(): UpdateState { return this.state }
  getDownloadedPath(): string | null { return this.downloadPath }

  private set(next: Omit<UpdateState, 'currentVersion'>): void {
    this.state = { ...next, currentVersion: this.options.currentVersion }
    this.options.onState?.(this.state)
  }

  async checkAndDownload(): Promise<UpdateState> {
    const fetcher = this.options.fetch ?? fetch
    const platform = this.options.platform ?? process.platform
    const arch = this.options.arch ?? process.arch
    this.set({ phase: 'checking', version: null, assetName: null, downloadedBytes: 0, totalBytes: null, message: null })
    try {
      const api = `https://api.github.com/repos/${this.options.repository}/releases/latest`
      const releaseResponse = await fetcher(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Warmstart' } })
      if (releaseResponse.status === 404) {
        this.set({ phase: 'unavailable', version: null, assetName: null, downloadedBytes: 0, totalBytes: null, message: 'No published release is available yet.' })
        return this.state
      }
      if (!releaseResponse.ok) throw new Error(`GitHub release check returned HTTP ${releaseResponse.status}`)
      const release = asRelease(await releaseResponse.json())
      if (!release || release.draft || release.prerelease) throw new Error('GitHub returned an invalid stable release record')
      const version = release.tag_name.replace(/^v/, '')
      if (!isNewerVersion(version, this.options.currentVersion)) {
        this.set({ phase: 'current', version, assetName: null, downloadedBytes: 0, totalBytes: null, message: 'Warmstart is up to date.' })
        return this.state
      }
      const asset = selectReleaseAsset(release.assets, version, platform, arch)
      if (!asset) {
        this.set({ phase: 'unavailable', version, assetName: null, downloadedBytes: 0, totalBytes: null, message: `Warmstart ${version} has no installer for ${platform}-${arch}.` })
        return this.state
      }
      const checksums = release.assets.find((candidate) => candidate.name === 'SHA256SUMS.txt')
      if (!checksums) throw new Error(`Warmstart ${version} has no SHA256SUMS.txt; refusing to download it`)
      if (new URL(checksums.browser_download_url).protocol !== 'https:') {
        throw new Error('release checksums are not served over HTTPS; refusing the release')
      }
      const checksumResponse = await fetcher(checksums.browser_download_url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Warmstart' } })
      if (!checksumResponse.ok) throw new Error(`could not read release checksums (HTTP ${checksumResponse.status})`)
      const expectedHash = checksumForAsset(await checksumResponse.text(), asset.name)
      if (!expectedHash) throw new Error(`SHA256SUMS.txt does not name ${asset.name}`)
      await this.download(fetcher, asset, version, expectedHash)
      return this.state
    } catch (err) {
      this.set({ phase: 'error', version: null, assetName: null, downloadedBytes: 0, totalBytes: null, message: String(err instanceof Error ? err.message : err) })
      return this.state
    }
  }

  private async download(fetcher: typeof fetch, asset: ReleaseAsset, version: string, expectedHash: string): Promise<void> {
    if (new URL(asset.browser_download_url).protocol !== 'https:') throw new Error('release download is not served over HTTPS')
    const updatesDir = join(this.options.dataDir, 'updates')
    await mkdir(updatesDir, { recursive: true })
    const destination = join(updatesDir, basename(asset.name))
    if (await this.matchesChecksum(destination, expectedHash)) {
      this.downloadPath = destination
      this.set({ phase: 'downloaded', version, assetName: asset.name, downloadedBytes: asset.size, totalBytes: asset.size, message: 'Already downloaded and verified. Open it when you are ready to install.' })
      return
    }
    const response = await fetcher(asset.browser_download_url, { headers: { Accept: 'application/octet-stream', 'User-Agent': 'Warmstart' } })
    if (!response.ok || !response.body) throw new Error(`could not download ${asset.name} (HTTP ${response.status})`)
    if (new URL(response.url).protocol !== 'https:') throw new Error('release download left HTTPS; refusing it')
    const partial = `${destination}.part`
    const total = Number(response.headers.get('content-length')) || asset.size || null
    this.set({ phase: 'downloading', version, assetName: asset.name, downloadedBytes: 0, totalBytes: total, message: null })
    const handle = await open(partial, 'w')
    const hash = createHash('sha256')
    let downloaded = 0
    try {
      const chunks = response.body as unknown as AsyncIterable<unknown>
      for await (const bytes of chunks) {
        if (!(bytes instanceof Uint8Array)) throw new Error('release download returned a non-binary chunk')
        await handle.write(bytes)
        hash.update(bytes)
        downloaded += bytes.byteLength
        this.set({ phase: 'downloading', version, assetName: asset.name, downloadedBytes: downloaded, totalBytes: total, message: null })
      }
    } finally {
      await handle.close()
    }
    if (hash.digest('hex') !== expectedHash) {
      await rm(partial, { force: true })
      throw new Error(`downloaded ${asset.name} did not match its published SHA-256 checksum`)
    }
    // The managed updates directory may retain an earlier interrupted download under this name.
    // Replace it only after the new bytes have passed the release's checksum.
    await rm(destination, { force: true })
    await rename(partial, destination)
    this.downloadPath = destination
    this.set({ phase: 'downloaded', version, assetName: asset.name, downloadedBytes: downloaded, totalBytes: total, message: 'Downloaded and verified. Open it when you are ready to install.' })
  }

  private async matchesChecksum(path: string, expectedHash: string): Promise<boolean> {
    try {
      return createHash('sha256').update(await readFile(path)).digest('hex') === expectedHash
    } catch {
      return false
    }
  }
}
