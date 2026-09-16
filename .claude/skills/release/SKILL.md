---
name: release
description: Prepare a release locally — bump the version in version.json, package.json and package-lock.json together, write releases/v<version>.md from the commits since the last tag, refresh HANDOFF.md, and commit. Does NOT tag or push; tagging is what publishes. Use when the user runs "/release", "/release minor", "/release patch", "/release 0.2.0-rc.1", or asks to "cut a release", "bump the version", or "prepare the release notes".
---

# /release — bump, notes, commit. **No tag, no push.**

Five steps, in order. **Only run this when asked** — `AGENTS.md` § Git.

## ⛔ Where this skill stops

It ends with one local commit: the version bumped everywhere it lives, `releases/v<version>.md`
written, `HANDOFF.md` current. It never runs `git tag` and never touches origin. **The tag is the
publish trigger** — `.github/workflows/release.yml` builds Windows and macOS installers and creates
the GitHub Release on a `v*` push — so making it is the operator's explicit act, done after the commit
has been through `/push` and CI is green. Say what the tag command is; do not run it.

## 0. ⛔ Is this base safe to release from? Run the gate before touching anything

```bash
npm run release:check      # node scripts/check-release-base.mjs
```

It fetches `origin/main` and refuses, exit 1, when any of these is true:

- **the trunk's `main` is ahead of `origin/main`** — the trap of 2026-09-15. `v0.1.0-rc.1` was
  tagged on `origin/main` while the trunk (`C:\Dev\warmstart`) sat 25 unpushed commits ahead, two of
  them migrations. The operator's daily app was built from that trunk and had already taken the
  live database to schema v73; the release understood v71, and its daemon refused the database on
  the first install. Anything the trunk knows that origin does not is a release that will refuse
  the machine it was built on.
- **this branch is behind `origin/main`** — the version would be bumped on a base origin has moved
  past.
- **the trunk has uncommitted tracked changes** — what it runs is not what can ship.

⛔ **A refusal ends this skill.** Say what it said and stop; do not bump, do not write notes, and
do not work around it by pushing the trunk yourself — that is `/push` *on the trunk*, which is the
operator's to run. A trunk merely *behind* origin is printed as a note and does not refuse.

## 1. Pick the version

The argument is one of `major`, `minor`, `patch`, `rc`, or a literal version. Default: `minor`.

```bash
node -p "require('./version.json').version"       # current
git tag --list 'v*' --sort=-v:refname | head -1   # last tag, if any
```

| Argument | From `0.1.0` | From `0.1.0-rc.1` |
|---|---|---|
| `patch` | `0.1.1` | `0.1.0` (⭐ finalises the rc) |
| `minor` | `0.2.0` | `0.2.0` |
| `major` | `1.0.0` | `1.0.0` |
| `rc` | `0.2.0-rc.1` | `0.1.0-rc.2` |
| `0.3.0-rc.1` | as given | as given |

⛔ A `-` in the version means **pre-release** and the workflow publishes it as one. Packaged
Warmstart polls `/releases/latest`, which GitHub never answers with a pre-release, so an `-rc`
build is invisible to installed apps and a bare version is the first thing they can see. Choose
accordingly, and say which it is.

## 2. Bump the version in all three files

`version.json` is the source; `package.json` and `package-lock.json` (both `version` and
`packages[""].version`) must agree or `npm run version:check` refuses every build.

```bash
npm version <version> --no-git-tag-version --allow-same-version   # package.json + lock, no tag, no commit
```

then set `version.json` to the same string with the Edit tool (do not regenerate the file), and

```bash
npm run version:check
```

⛔ `npm version` must have `--no-git-tag-version`; without it, it commits and tags on its own.

## 3. Write `releases/v<version>.md`

Read [`releases/README.md`](../../../releases/README.md) for the shape. The material:

```bash
git log --no-merges --format='%h %s' $(git tag --list 'v*' --sort=-v:refname | head -1)..HEAD
```

(no tag yet → `git log --no-merges --format='%h %s' HEAD` and summarise the state, not the history).
`HANDOFF.md` § *Closed* is the better source for *what a change meant*; the log is the list of what
happened. Write in the same voice as HANDOFF's entries — what a user can now do, what they must
do to upgrade, what is known broken — in that order, not the commit list verbatim.

⛔ **Upgrade notes are not optional.** If the `appId`, the data directory, the schema, or an on-disk
identifier changed since the last release, the first section says what the upgrader must do. Carry
forward any still-true caveat from the previous version's file rather than assuming it was read.

Do not write a top-level `#` heading — the release title is `Warmstart v<version>`, and the
workflow appends the download-verification and platform sections after this file's content.

## 4. HANDOFF, then commit

Run the gate once more — `npm run release:check` — because step 3 took time and origin may have
moved. Then update `HANDOFF.md` § *Current state* with the version and what the release is waiting on, and
commit everything in one commit on the current branch:

```
Prepare v<version>
```

Say clearly that it is **committed, unpushed and untagged**, and finish with the two commands the
operator runs once `/push` has taken the commit to `main` and CI is green:

```bash
git tag v<version> && git push origin v<version>
```

The `Release` workflow rejects a tag whose `releases/v<version>.md` is missing or whose version does
not match `version.json`, both before it installs anything — so a wrong tag costs seconds, not a
macOS build.
