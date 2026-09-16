import versionInfo from '../../version.json'

/**
 * The one version a Warmstart build claims everywhere: the UI, orchestratord, the MCP handshake,
 * release filenames, and the GitHub-release update lookup.
 *
 * It is not read from a file. `scripts/version.mjs` derives it from git — the tag on a release
 * build, `<last tag>+<n>.g<sha>` between releases — and every bundle receives it as the
 * `__APP_VERSION__` constant (`electron.vite.config.ts`, `vite.mobile.config.ts`, `vitest.config.ts`);
 * `electron-builder.js` stamps the same value into the package. `scripts/check-version.mjs` refuses
 * a build the moment a version is written into `version.json` or `package.json` again.
 */
declare const __APP_VERSION__: string

export const APP_VERSION = __APP_VERSION__
export const RELEASE_REPOSITORY = versionInfo.releaseRepository
