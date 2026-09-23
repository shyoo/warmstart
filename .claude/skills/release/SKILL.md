---
name: release
description: Cut a release in one turn — "/release rc" tags the next release candidate on origin/main and the Release workflow builds and publishes it as a pre-release; "/release promote" tags the verified rc's commit with the final version so it becomes /releases/latest. No commit, no version bump — the tag is the version and its message is the notes. Use when the user runs "/release", "/release rc", "/release rc minor", "/release promote", "/release 0.3.0-rc.1", or asks to "cut an rc", "promote the rc", "ship the release" or "make it latest".
---

# /release — plan, notes, tag, push. **No commit.**

**Only run this when asked** — `AGENTS.md` § Git. One turn from request to a tag on origin; the
installers build in the background (~8 min, Windows + macOS) and publish themselves.

## ⛔ What this skill does not do

It never bumps a version, writes a tracked file or makes a commit. The version is a git fact
(`scripts/version.mjs`: the tag on a release build, `<last tag>+<n>.g<sha>` between them), and the
release notes are the annotated tag's message. If you find yourself editing `package.json`,
`version.json` or anything under `releases/`, stop — that was the 2026-09-15 flow, and it cost two
"Prepare vX" commits, two CI runs and four turns per release for nothing a test could catch.

It never tags what CI has not passed, and it makes no commit of its own. Publishing is still
`/push`'s job — but step 0.5 *calls* `/push` for you when the only thing in the way is a trunk that
is ahead of origin, so the person does not have to run two skills to get one rc.

## 0. Plan

The argument is `rc` (default), `promote`, or a literal version. `rc` takes an optional bump;
⭐ **the default is patch** — pass `minor` or `major` only when the person asks for one.

```bash
node scripts/release-tag.mjs plan rc                 # next rc: continues the open series, else patch (0.2.0 → 0.2.1-rc.1)
node scripts/release-tag.mjs plan rc --bump minor    # 0.2.0 → 0.3.0-rc.1 (or major)
node scripts/release-tag.mjs plan promote            # the highest open rc → its bare version
node scripts/release-tag.mjs plan 0.3.0-rc.1         # by hand; must be above every existing tag
```

It prints the version, the commit it would tag, the last final to write notes since, and whether
the result is a **pre-release** (invisible to installed apps — `/releases/latest` never serves one)
or **latest** (every installed app is offered it). ⛔ A refusal ends this skill: say what it said.

- `rc` tags **`origin/main`'s tip**. If the trunk is ahead of origin, step 0.5 publishes it first.
- `promote` tags **the rc's own commit**, not HEAD — what the person verified is what ships. `main`
  may have moved on; that is fine and expected.

## 0.5. Clear the base — publish the trunk yourself if that is all that is wrong

Run the gate now rather than discovering it at step 2, because the commit you write notes for
changes when the trunk lands:

```bash
node scripts/check-release-base.mjs
```

Silence-plus-`release base ok` → go to step 1. Otherwise read *which* problems it printed; they are
not equivalent:

| What it said | What you do |
|---|---|
| **only** `the trunk's main is N commit(s) ahead` | ⭐ Invoke the **`/push`** skill, then re-run the gate and `plan` — do not ask first. Publishing commits the person already made is what they asked for by asking for a release. |
| `uncommitted change(s)` | ⛔ Stop and ask. Those edits may belong to another agent or to work in progress; `/release` has no standing to commit them. |
| `this branch is N commit(s) behind` | ⛔ Stop and say so. You are cutting from a stale base; that is a checkout problem, not a release one. |

⛔ **`/push` is a Claude Code slash command** (`AGENTS.md` § Git). A codex or `agy` worker cannot
invoke it and must not improvise one — there, the trunk-ahead refusal ends the skill as before.

⚠️ `/push` runs the suites, builds, commits its own docs refresh and pushes, so the tip moves. Re-run
`plan` afterwards: the sha you tag is the one it just published, not the one step 0 printed. `/push`
watches CI to green, which is also the proof step 2 needs — if you left it running, `cut --wait`
picks the wait back up.

## 1. Write the notes

For `promote`, start from the rc's notes and fold in anything a later rc added:

```bash
git tag -l --format='%(contents:body)' v<rc>
```

For `rc`, the material is the change since the last final:

```bash
git log --no-merges --format='%h %s' <since>..<commit>
```

`HANDOFF.md` § *Closed* says what a change *meant*; the log is the list. Write in HANDOFF's voice —
what a user can now do, what they must do to upgrade, what is known broken — in that order, under
`## Upgrading from <previous>` (only if the `appId`, data directory, schema or an on-disk identifier
changed; carry forward a still-true caveat), `## What's new`, `## Known problems`. No top-level `#`
heading: the release title is `Warmstart v<version>`, and the workflow appends the verification and
platform sections. Save it under `.build-cache/` (gitignored; `mkdir -p` it if missing):

```bash
.build-cache/notes-v<version>.md
```

Show the notes in the reply. They are what the person will read on the Releases page.

## 2. Cut

```bash
node scripts/release-tag.mjs cut <version> --notes .build-cache/notes-v<version>.md --dry-run
node scripts/release-tag.mjs cut <version> --notes .build-cache/notes-v<version>.md
```

⛔ **For a `promote`, pass `--commit <the rc's commit>`** — the sha `plan promote` printed. `cut` takes
a *version*, not the word `promote`, and defaults the commit to `origin/main`'s tip, so without it a
promotion silently tags whatever has landed since the rc instead of the bytes that were verified.
⚠️ Read the dry run's first line and check the sha is the rc's; it says which commit it would tag.

The dry run prints the full tag message and every gate's verdict; the real run tags and pushes
only when all of them pass:

- **the base** — `check-release-base.mjs` again, unchanged by step 0.5: the trunk has nothing origin
  lacks, this branch is not behind, the trunk is clean (the 25-commits-ahead trap of 2026-09-15
  still applies). ⛔ The gate is never relaxed; 0.5 only removes the cause;
- **the commit is on `origin/main`**, and the tag does not exist here or there;
- **the version goes forward** — above every tag that exists;
- **CI passed on that commit.** The Release workflow runs no tests, so this is the only proof.
  Still running → `--wait` (it watches `gh run watch`), or come back. Red → stop.

`release.yml` re-checks the same things on the far side before `npm ci`, so a tag that slipped
through costs seconds, not a macOS build.

## 3. Report, and watch

```bash
gh run list --workflow release.yml --limit 1
```

Say the version, the commit, whether it publishes as a **pre-release** or **latest**, and the URL
`https://github.com/shyoo/warmstart/releases/tag/v<version>`. Offer to watch the run (~8 min). For
an rc, say what comes next: install it, verify it, then `/release promote`. For a final, say that
installed apps will be offered it on their next update poll.

Wrong wording after the fact is fixed on GitHub, not in git: `gh release edit v<version> --notes-file …`.
The tag's message stays as it was cut.
