# Release notes

One file per version, `v<version>.md`, written when the version is bumped (`/release`) and read by
`.github/workflows/release.yml` as the first part of the GitHub Release body. A `v*` tag whose file is
missing fails the workflow before anything is built.

Not `docs/` — these are neither reference nor status; they are what a person installing that version
needs to know, frozen at the moment it shipped. Never edit one after its tag exists.

## Shape

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
