import versionInfo from '../../version.json'

/**
 * The one version a Warmstart release claims everywhere: the UI, orchestratord, MCP handshake,
 * release filenames, and GitHub-release update lookup. `scripts/check-version.mjs` makes the
 * package-manager metadata agree before a build or release can proceed.
 */
export const APP_VERSION = versionInfo.version
export const RELEASE_REPOSITORY = versionInfo.releaseRepository
