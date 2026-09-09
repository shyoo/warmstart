# CLI update health — design, 2026-09-08

Status: decision-ready; no runtime change until the product policy in §8 is chosen.

## 1. Answer today

Multi Agent Controller does **not** report that an agent CLI has an update available or requires an
update. `AdapterDetection` carries only `found`, `path`, `version`, and `error`; Doctor displays
those values but has no latest/recommended version to compare. The quota Probe button does not check
software versions.

Measured locally on 2026-09-08:

- `claude --version` returned 2.1.266 and `claude update --help` described an operation that checks
  **and installs** an update.
- `codex --version` returned 0.151.0. `codex doctor --json` exposed a structured `updates.status`
  check, the cached latest version and its age, the installation method, the exact update action,
  and whether that action targets the running npm installation. Its live latest-version fetch could
  not reach GitHub from this sandbox, and correctly retained the cached evidence rather than calling
  the CLI current.
- `agy` was not on this process's PATH. The repository's last live measurement was 1.1.25
  (`HANDOFF.md`); this turn therefore makes no new runtime claim about its output.

## 2. Vendor facts

Checked 2026-09-08 against primary vendor sources:

| CLI | Read-only evidence | Upgrade action | Consequence |
|---|---|---|---|
| Claude Code | Its documented updater checks on startup and periodically, downloads in the background, and applies on the next start. No stable machine-readable check-only command is documented. | `claude update`; automatic unless disabled | Observe the installed version and vendor cache/notice if a stable source is measured; do not invoke the mutating updater as a probe. |
| Codex | `codex doctor --json` now has a structured `updates.status`, cached/latest versions, check age, install provenance and target-consistency check. Its official source uses a bounded latest-release lookup. | npm, pnpm, bun, Homebrew, or standalone installer according to detected provenance | Delegate diagnosis to Doctor and retain its basis. Do not guess the package manager from the executable name. |
| Antigravity | The official install page says the install scripts install or upgrade. The CLI exposes `agy update`, but the command is evidenced as checking and updating, not as a read-only status API. | `agy update` or rerun the platform installer | Do not call it during Probe. Add a passive source only after measuring a stable manifest/cache contract. |

Sources: [Claude Code setup and updates](https://docs.anthropic.com/en/docs/claude-code/getting-started),
[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
[Codex update diagnostics source](https://github.com/openai/codex/blob/main/codex-rs/cli/src/doctor/updates.rs),
[Codex installer source](https://github.com/openai/codex/blob/main/scripts/install/install.ps1), and
[Antigravity installation](https://www.antigravity.google/docs/cli/install/).

These sources establish update mechanisms, not a vendor support floor. None found in this research
publishes a general rule that an older version is “required” to update.

## 3. Product model

Version health belongs to an **adapter capability**, never an adapter-name branch:

```ts
type UpdateProbe = 'vendor-doctor' | 'local-cache' | 'release-endpoint' | 'none'

interface UpdateCapability {
  probe: UpdateProbe
  cadenceMs: number | null
  canUpdate: boolean
  verification: CapabilityVerification
}

interface CliUpdateReading {
  adapterId: string
  installedVersion: string | null
  latestVersion: string | null
  status: 'current' | 'available' | 'required' | 'unknown'
  checkedAt: number | null
  source: string
  updateAction: { label: string; argv: string[] } | null
  installProvenance: string | null
  detail?: string
}
```

`required` is not “many releases behind” and is never inferred from semver. It is set only from an
explicit vendor signal (a refusal naming a minimum version, a signed/authoritative minimum-supported
version field, or a measured structured Doctor verdict). Otherwise a newer version is `available`.
An unreachable endpoint, stale cache, unparsable version, prerelease/stable channel mismatch, or
unsupported adapter is `unknown`, with its basis and age.

External declarative adapters default to `probe: 'none'`. A future schema may allow a fixed
informational URL, but it must not allow arbitrary commands or executable update actions from the
data directory.

## 4. When checks run

Create a small `cliupdates.ts` service with a persisted reading per **adapter installation**, not per
worker. Claude and Codex may have many credential roots but normally share one executable; probing
each worker would duplicate network traffic and contradictory results.

- Run once after daemon startup only when the last attempt is at least seven days old.
- Run on explicit Doctor refresh regardless of age, while coalescing concurrent requests.
- Do not attach it to quota Probe. Quota is per worker and dispatch-critical; software update health
  is per executable, slow, network-dependent and informational.
- Bound the nearest network/process wait. A failed check records `unknown` and never gates work.
- Cache successes and failures with `checkedAt`; never display a latest version without its age.
- Add small deterministic jitter if fleet-wide installations ever make the weekly check synchronized.

The weekly cadence costs no tokens. The adapter performs only a documented local/cache/status read
or a bounded release-metadata request; it never starts an agent turn.

## 5. Presentation and behavior

Doctor becomes the complete view: installed version, status, latest version and age, evidence source,
install provenance, and remediation. Workers shows one compact adapter-level warning rather than
repeating it on every account. `available` is amber/informational; `required` is red/actionable;
`unknown` says why and is not styled as current.

Neither `available` nor `required` changes eligibility in the first implementation. Automatically
withholding every worker of a provider can halt unattended work based on a network/cache error. If a
CLI itself refuses work because its version is unsupported, the existing run failure is surfaced and
the adapter may classify that measured refusal as `required` for subsequent runs; gating on such a
signal would be a separate, evidence-backed change.

## 6. Updating safely

An upgrade changes a host-wide executable used by multiple workers and potentially live processes.
It therefore must not run inside quota probing or on a timer in the initial design.

If user-initiated updates are enabled:

1. Resolve the executable and installation provenance again immediately before acting.
2. Refuse while that adapter has live work, login, probe, judgment or review sessions.
3. Show the exact executable, current/latest versions, command and scope; require confirmation.
4. Run only an adapter-declared argv through the normal spawn boundary, never a shell string.
5. Re-run `detect()` and the update check afterward. Success means the resolved executable now
   reports the expected/newer version; exit code zero alone is not evidence (multiple copies on PATH
   are a documented failure mode in Codex's own diagnostics).
6. Keep the previous reading and report the failure verbatim if verification fails. Never delete or
   replace binaries directly.

Claude's own background updater remains authoritative. Multi Agent Controller should not race it.
Antigravity's `agy update` is suitable for the confirmed action, not for discovering whether action
is necessary. Codex's Doctor-provided action is suitable only after its target-consistency check
passes.

## 7. Implementation slices and proof

1. Add update capability/readings and pure semver/channel parsing tests. Unknown is the default.
2. Add SQLite migration for readings/attempts and a coalesced weekly service with fake-clock tests:
   once per executable, seven-day boundary, retry result, timeout, restart persistence.
3. Implement Codex Doctor parsing first. Fixture every status, stale cached evidence, unreachable
   latest lookup, package-target mismatch and malformed JSON.
4. Add Claude and Antigravity passive probes only after a live experiment identifies a stable,
   read-only source. Until then they report `unknown` plus “the CLI manages its own updates.”
5. Add Doctor and Workers UI, including age and evidence. L2 must assert a non-empty adapter list;
   L3 should drive the visible state with fixture adapters rather than relying on host versions.
6. If chosen, add confirmed update RPC, remote-policy denial, no-live-session guard, exact argv,
   post-update path/version verification and audit log.

Acceptance is not “the command exited”: an old fixture reports `available`; an explicit support-floor
fixture reports `required`; offline/stale/malformed inputs report `unknown`; no update check spends a
turn; no scheduled path mutates the host; and an update cannot run while the resolved adapter is live.

## 8. Major product decision

Recommended: ship passive weekly/on-demand health plus a user-confirmed **Update** action. It gives
the safeguard requested without silently changing a shared dependency beneath unattended work.

Alternatives are passive reporting only, or opt-in unattended upgrades during an idle maintenance
window. The latter needs rollback/provenance design beyond this proposal and remains risky where a
vendor release regresses authentication or stream formats, so it should not be the first release.

