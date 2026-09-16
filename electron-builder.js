// The entry electron-builder actually loads (it looks for `electron-builder.yml` before `.js`, so
// the settings file is named `.base.yml` to make this one win). Everything a person maintains is in
// `electron-builder.base.yml`; this file's only job is to stamp the version, which is a git fact
// (`scripts/version.mjs`) and lives in no file that could be committed stale.
//
// ⛔ `extraMetadata.main` must still not be set - see the note at the top of the yml.
import { resolveVersion } from './scripts/version.mjs'

export default {
  extends: 'file:./electron-builder.base.yml',
  extraMetadata: { version: resolveVersion() }
}
