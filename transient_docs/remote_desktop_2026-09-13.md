# Remote desktop connection — design of record (t419, 2026-09-13)

Dated plan. Status lives in `HANDOFF.md`; the maintained reference is `docs/remote.md`.

## Goal

One Warmstart desktop drives another machine's fleet over Tailscale, with the same UI it uses for
its own. A drop-down above **Overview** picks *This computer* or a registered remote.

## Why it is small

The renderer already reaches the fleet only through `rpc(method, params)` and pushed `DaemonEvent`s,
and Electron main is the daemon's only client. A remote is therefore a second *client in main*
pointed at the other machine's existing remote listener; the renderer is re-keyed onto whichever
target is selected.

## Decisions (operator, 2026-09-13)

| # | Question | Decision |
|---|---|---|
| 1 | Authority of a paired desktop | **Full parity minus `daemon.shutdown`.** Every event, including terminal bytes. `agent.*` (the MCP identity) and `remote.subscribe` (a phone's push) stay denied because no desktop surface calls them. |
| 2 | Gating and transport | Same listener/port as phones; `remote_devices.kind` (`phone` / `desktop`) picks the policy. A separate host switch, **Allow paired desktops**. No per-project gate for desktops. Desktop tokens only over **TLS on the Tailscale hostname**. |
| 3 | Client storage | Main-owned `remotes.json` beside `ui-settings.json`; token encrypted with Electron `safeStorage`. No keychain ⇒ pairing refused, never plaintext. |
| 4 | Connections | Local daemon always, plus the **selected** remote only. Notifications from both, a remote's labelled with its name. Switching resets the route. Folder picker hidden for a remote; tray, quit and updates stay local. |
| 5 | Version skew | **Negotiated RPC version range.** Each side declares `{min,max}`; the highest common version is used; no overlap ⇒ refuse; remote `max` below ours ⇒ connect with a warning that the remote needs upgrading. Follow-up: compatibility spans **at most ±1 version** (`RPC_COMPATIBILITY_SPAN`). |

## Pieces

- **shared/rpcversion.ts** — `RPC_VERSION`, `negotiateRpcVersion`, `parseDesktopPairing`.
- **daemon** — migration 71 (`remote_devices.kind`); `remote_config.desktopsEnabled`; pairing codes
  carry the kind (a phone code can never mint a desktop token); `desktoppolicy.ts` deny list (prefix-denies `agent.`);
  `/remote/hello` (public: app version + RPC range); `x-warmstart-rpc` header checked on every
  desktop call; listener runs while *either* switch is on, and a phone token is refused while
  phones are off.
- **main** — `remotes.ts` (store), `remoteclient.ts` (hello → negotiate → HTTPS RPC + WSS events,
  reconnect backoff), `targets.ts` (active target, status, routing of rpc/events, background
  `task.changed` from the local daemon for notifications).
- **renderer** — `Root` holds the target list and remounts `App` keyed by target; `MachinePicker`
  above Overview; **Remote Warmstarts** panel under Settings → Global; desktop pairing in
  Remote access; `rpc()` names the target it believes it is on, and main refuses a call that
  arrives after a switch.

## Not done, deliberately

Background sockets to unselected remotes; Tailscale peer-identity checks (`tailscale whois`); a
per-method "since version" table (only v1 exists — the contract for v2 is in `docs/remote.md`).
