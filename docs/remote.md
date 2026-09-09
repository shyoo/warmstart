# Remote access

A paired phone can watch the fleet, answer what is waiting, and file work. It is a deliberately
smaller front door than the daemon's own, and it is off until you turn it on.

## Boundary

The daemon's loopback endpoint stays local. Its bearer token authorises spawning processes and never
leaves the computer. A phone gets a *different* credential — a per-device token, minted at pairing,
stored only as a SHA-256 hash, revocable — and reaches only the allowlist in
[`src/daemon/remote/policy.ts`](../src/daemon/remote/policy.ts).

⛔ That allowlist is a total map over `RpcMethod`, so **a new RPC method is denied until someone
decides otherwise** — adding one without a decision fails the build by name. What a phone may not do:
shut the daemon down, administer workers or projects, change fleet settings, delete a task, or type
into a live agent's terminal (`session.write`). Two more are denied for a reason worth knowing:

- `session.backscroll` names a *session*, and a session does not name a project, so the per-project
  switch could not be applied to it.
- `task.page` is sliced in SQLite before any project filter could run, so a filtered page would come
  back short with a `total` counting rows the phone was never allowed to know about. The phone uses
  `task.list` and sorts what it is given.

There are two switches, and both must be on. Remote access must be enabled for the machine, then each
project must be enabled individually. ⛔ Project exposure is stored in the daemon database, never in
the committed `.multi_agent_controller/project.json` — that file is pulled by every clone and by every
machine, and whether *this* computer is reachable from a phone is not a fact about the repository.

Every call is checked against the project it belongs to, by the parameter that actually carries it:
a task through its id, a question or approval through the task it was asked on, and the two
fleet-wide lists (`approval.list`, `question.list`) filtered on the way out. A project you have not
enabled answers `404`, not `403` — it should not be distinguishable from one that does not exist.

## Setup

1. Install Tailscale on the computer and the phone, and sign both into the same tailnet.
2. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**. The desktop
   *Remote access* screen names whichever of these is still missing, one step at a time.
3. Turn on **Allow paired phones**, enable the projects the phone may reach, and press
   **Generate pairing code**.
4. Scan the QR code with the phone. The code is eight characters, lives two minutes, and works once.
5. Add the opened page to the phone's home screen, then turn on notifications from the app.

Success looks like an `https://…ts.net:<port>` address on the desktop screen and the phone in the
paired-device list. It is private to the tailnet, not a public internet address: the phone must also
be connected to Tailscale and signed into that tailnet. If the address is missing, finish step 2 and
press **Re-check Tailscale**, which runs a new local probe rather than showing the prior result. If
Tailscale's local service or certificate request refuses the probe, the screen shows its error; check
that the service is running, the desktop app may access it, and the device may issue a certificate.
If the port is taken, change it on the same screen. ⚠️ No inbound port forwarding is involved at any
point.

## Tailscale, or a plain LAN

| | Tailscale (`https://…ts.net`) | LAN (`http://192.168.…`) |
|---|---|---|
| Encrypted | yes, with a real certificate | no |
| Installable to the home screen | yes | no |
| Notifications | yes | **no** |
| Port forwarding | none | none, but same network only |

The gap is not a preference. Service workers, home-screen install and Web Push all require a
**secure context**, and a bare IP address over plain HTTP is not one — on a LAN address the browser
does not merely refuse to subscribe, `PushManager` does not exist. The phone app says so and names
the fix rather than showing a control that cannot work.

⛔ The Tailscale certificate is issued for `host.tailnet.ts.net` and nothing else, so the listener
uses TLS only when that hostname is one of the addresses it is offering. Set to **LAN only**, it
serves plain HTTP rather than presenting a certificate whose name could never match.

## Pairing and revocation

A pairing code mints a random 32-byte device token. Only its hash is stored; the token is shown to
the phone once and never again. Pairing is the one unauthenticated route, and it is rate-limited per
address.

Revoke a phone from the desktop screen the moment it is lost or no longer trusted. Revocation takes
effect on the next request, and takes that device's notification subscriptions with it — a revoked
handset that kept receiving pushes would still be told what the fleet is doing.

## Notifications

Notifications are browser **Web Push**, over the Tailscale HTTPS address. The daemon signs each one
with a VAPID key it generates on this machine, encrypts the payload for that phone alone (RFC 8291),
and POSTs it to the push service the subscription names. ⚠️ This needs only *outbound* internet from
the daemon; it is why a notification arrives when the phone is asleep on another network, where the
live event socket does not.

The bar for waking someone is deliberately low in count and high in importance: a question, an
approval, a task resting at `awaiting_human`, a task held by the quota gate, and a task about to be
preempted. Progress is not a notification. The same alert is sent at most once every ten minutes,
because `task.changed` fires far more often than anything about it has changed.

⛔ A payload carries a title, one sentence, and a task id — never a prompt, a file path or a
credential. It is decrypted by the phone and shown on a lock screen anyone holding it can read.
