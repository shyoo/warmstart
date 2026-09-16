# The tag is the version — release flow redesign

**2026-09-16 · t485 · design of record, not status.** Status lives in `HANDOFF.md`; the maintained
description is `docs/development.md` § *Cutting a release*.

## 1. What was wrong, measured

`v0.1.0` shipped on 2026-09-16 through this sequence (runs read from `gh run list` the same day):

| Step | Turn | GitHub time |
|---|---|---|
| `/release rc` — bump `version.json` + `package.json` + lock, write `releases/v0.1.0-rc.2.md`, commit | 1 | — |
| `/push` — local suites (~15 min), push, CI | 2 | CI 35062655991, **9m04s** |
| hand tag `v0.1.0-rc.2` | — | Release 35063333496, **7m34s** |
| `/release patch` — same three files again, `releases/v0.1.0.md`, commit | 3 | — |
| `/push` | 4 | CI 35066176973, **6m37s** |
| hand tag `v0.1.0` | — | Release 35066743396, **8m08s** |

Four turns, two hand steps, two CI runs whose only input was a version string. The two commits
(`6f2f887`, `0336dce`) touched nothing a test can see, and the operator's observation was exact:
the process was heavy because the *version was a source fact*, so every change to it had to go
through the whole pipeline before a tag could point at it.

## 2. Decisions (operator, 2026-09-16, t485)

1. **The tag is the version.** `version.json` stops carrying one; `package.json` keeps `0.0.0`.
   Chosen over "keep `version.json`, make the skill bump+commit+push+tag atomically" because that
   would have run the heavy steps faster rather than removing them.
2. **Promote = retag the same commit and rebuild.** Chosen over flipping the rc release's
   pre-release flag (same bytes, but the shipped version would stay `-rc.N` forever and no final
   tag would exist; installed `0.1.0` apps would be offered "0.2.0-rc.1"). The rebuild costs ~8
   minutes; the commit and the attestation subject are the same.
3. **Notes live on the annotated tag.** `releases/` takes no new files. Chosen over also keeping
   a copy under `releases/` riding on the next ordinary push — one source of truth, and the
   Releases page is where a person reads them.

## 3. How the version reaches every consumer

```
git describe --tags --match 'v*' --long --dirty        WARMSTART_VERSION (release.yml, from the tag)
                    └──────────────┬──────────────────────────────┘
                     scripts/version.mjs  resolveVersion()
            ┌──────────────────────┼─────────────────────────┐
  electron.vite.config.ts   vitest.config.ts          electron-builder.js
  vite.mobile.config.ts     (define __APP_VERSION__)  extraMetadata.version → package in asar,
  (define __APP_VERSION__)                             artifactName ${version}, installer metadata
            │
  src/shared/version.ts  APP_VERSION → window, orchestratord, MCP handshake, /remote/health
```

- Between releases the version is `0.1.0+7.gcced61f`; dirty trees add `.dirty`. `isNewerVersion`
  compares the triple and the pre-release flag only, so a trunk build is not nagged about the
  release it already contains — and the first newer triple is the first thing it is offered.
  ⭐ Measured 2026-09-16: `npm run pack` on this branch produced an asar whose `package.json`
  reads `0.1.0+7.gcced61f.dirty`, and the packaged daemon answered its RPC with the same string
  (`test:pack`, 19 checks).
- electron-builder finds `electron-builder.yml` before `.js` (`app-builder-lib/out/util/config/load.js`,
  read 2026-09-16: `.yml, .yaml, .json, .json5, .toml, .js, .cjs, .ts`), so the settings file is
  renamed `electron-builder.base.yml` and `electron-builder.js` extends it with one stamped field.
  ⛔ **REVERSED the same day.** That JS config made `electron-builder --dir` exit 0 on Windows CI
  without packaging anything (run 35158401830, twice). The yml is `electron-builder.yml` again and the
  version is passed by `scripts/pack.mjs` as `-c.extraMetadata.version`; see that file and `HANDOFF.md`.
- `scripts/build-win.ps1` / `build-mac.sh` fingerprint inputs by content, and a tag is not content.
  Both now write the resolved version to `.build-cache/version.txt` and hash that, so a new tag
  alone re-bundles and re-packs.
- `check-version.mjs` inverts its old job: it refuses a build when `version.json` carries a
  `version` or `package.json` leaves `0.0.0`.

## 4. The two turns

`/release rc` → `scripts/release-tag.mjs plan rc` (next version from the tags that exist:
continue the open rc series, else a minor above the last final; `--bump patch|major`) → the agent
writes notes since the last final → `cut <version> --notes <file>` gates and pushes one annotated
tag on `origin/main`'s tip. `release.yml` builds with `WARMSTART_VERSION=<tag>` and publishes a
pre-release with the tag body as notes.

`/release promote` → `plan promote` names the highest open rc's bare triple **on the rc's commit**
→ notes carried from the rc's tag → `cut`. Same workflow, publishes as latest.

Gates, in `cut` and again in the workflow before `npm ci`: the trunk has nothing origin lacks
(`check-release-base.mjs`, unchanged), the commit is on `origin/main`, the tag is new and the
version is above every existing tag, the tag is annotated with a non-empty body, and the CI run
on that commit concluded `success` (`gh api …/workflows/ci.yml/runs?head_sha=`). `--wait` watches
an in-progress run. Pure decisions are pinned in `src/daemon/releaseplan.test.ts`.

## 5. What is not yet measured

- The first tag cut this way. `release.yml`'s new verify step (annotated-tag fetch, `merge-base
  --is-ancestor`, the CI lookup with `GH_TOKEN`) has been reasoned through against GitHub's
  documented behaviour, not run. The first `/release rc` after this lands is the test; a failure
  there costs seconds, before `npm ci`.
- Whether `actions/checkout` with `fetch-depth: 0` makes the publish job's `git describe` agree
  with the build job's on a `workflow_dispatch` run (both are told nothing; both describe HEAD).
