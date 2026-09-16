# Release notes — the three cut before the tag carried them

`v0.1.0-rc.1`, `v0.1.0-rc.2` and `v0.1.0` (2026-09-15/16) were released by a flow that bumped
`version.json` and committed a notes file here per version. That flow is gone: since 2026-09-16 the
**tag is the version and the annotated tag's message is the notes** (`scripts/release-tag.mjs`,
`docs/development.md` § *Cutting a release*), so this directory takes no new files. Read a later
release's notes with `git tag -l --format='%(contents:body)' v<version>` or on the Releases page.

The three files stay as they shipped. Never edit one after its tag exists.

## Shape — still the shape of a tag's notes

No `#` heading — the release title is `Warmstart v<version>`. Then, in this order, each section only
if it has content:

```markdown
## Upgrading from <previous>

What the upgrader must do by hand, if anything (uninstall the old app, move a directory, …).

## What's new

Short entries: what a user can now do. Group by area when there are more than ~8.

## Known problems

What is known broken or unverified in this build, honestly.
```

The workflow appends **Verify your download** (checksums, attestation when the repository can
make one) and one section per platform actually present in the release; do not repeat those here.
