import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checksumForAsset,
  isNewerVersion,
  parseVersion,
  selectReleaseAsset,
  UpdateManager,
  type ReleaseAsset
} from './updates.js'

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function response(body: string | Uint8Array, url: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const base = new Response(body, init)
  return {
    ok: base.ok, status: base.status, headers: base.headers, body: base.body,
    json: () => base.json(), text: () => base.text(), url
  } as Response
}

describe('release update selection', () => {
  it('compares only ordinary semver release tags', () => {
    expect(parseVersion('v0.1.2')).toEqual([0, 1, 2])
    expect(parseVersion('nightly-1')).toBeNull()
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0-beta.1', '0.1.0')).toBe(false)
  })

  it('accepts only the exact platform and architecture installer name', () => {
    const assets: ReleaseAsset[] = [
      { name: 'warmstart-0.2.0-win-arm64.exe', browser_download_url: 'https://example.invalid/arm', size: 1 },
      { name: 'warmstart-0.2.0-win-x64.exe', browser_download_url: 'https://example.invalid/x64', size: 1 },
      { name: 'warmstart-0.2.0-mac-x64.dmg', browser_download_url: 'https://example.invalid/mac', size: 1 },
      { name: 'Warmstart Setup 0.2.0.exe', browser_download_url: 'https://example.invalid/old', size: 1 }
    ]
    expect(selectReleaseAsset(assets, '0.2.0', 'win32', 'x64')?.name).toBe('warmstart-0.2.0-win-x64.exe')
    expect(selectReleaseAsset(assets, '0.2.0', 'darwin', 'arm64')).toBeNull()
  })

  it('reads a checksum only when it names the selected installer exactly', () => {
    const digest = 'a'.repeat(64)
    expect(checksumForAsset(`${digest} *warmstart-0.2.0-win-x64.exe`, 'warmstart-0.2.0-win-x64.exe')).toBe(digest)
    expect(checksumForAsset(`${digest} warmstart-0.2.0-win-x64.exe.bak`, 'warmstart-0.2.0-win-x64.exe')).toBeNull()
  })
})

describe('release download', () => {
  it('downloads a newer exact installer only after its published SHA-256 matches', async () => {
    const bytes = new TextEncoder().encode('verified release bytes')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const root = await mkdtemp(join(tmpdir(), 'warmstart-update-'))
    made.push(root)
    const asset: ReleaseAsset = {
      name: 'warmstart-0.2.0-win-x64.exe', browser_download_url: 'https://downloads.example/warmstart.exe', size: bytes.length
    }
    const fetch = async (url: string | URL): Promise<Response> => {
      const value = String(url)
      if (value.includes('/releases/latest')) {
        return response(JSON.stringify({ tag_name: 'v0.2.0', draft: false, prerelease: false, assets: [
          asset, { name: 'SHA256SUMS.txt', browser_download_url: 'https://downloads.example/SHA256SUMS.txt', size: 1 }
        ] }), value)
      }
      if (value.endsWith('SHA256SUMS.txt')) return response(`${hash} *${asset.name}\n`, value)
      return response(bytes, value, { headers: { 'content-length': String(bytes.length) } })
    }
    const updates = new UpdateManager({ currentVersion: '0.1.0', repository: 'shyoo/warmstart', dataDir: root, platform: 'win32', arch: 'x64', fetch: fetch as typeof globalThis.fetch })

    await updates.checkAndDownload()

    expect(updates.getState()).toMatchObject({ phase: 'downloaded', version: '0.2.0', assetName: asset.name, downloadedBytes: bytes.length })
    expect(await readFile(updates.getDownloadedPath()!)).toEqual(Buffer.from(bytes))
  })
})
