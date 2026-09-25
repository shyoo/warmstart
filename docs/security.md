# Security model

Warmstart runs coding agents, and coding agents can execute code. Treat every task prompt and every
repository an agent reads as untrusted input until you have decided otherwise.

## Unattended authority

| Adapter | Unattended mode | Effective boundary |
|---|---|---|
| Claude Code | `bypassPermissions` | Your OS user's full authority |
| Antigravity | `--dangerously-skip-permissions` | Your OS user's full authority |
| Codex, set to Sandboxed adapters only (default) | `--sandbox workspace-write` | Workspace sandbox, widened to the repository's shared `.git`; outbound network open, no credential inside |
| Codex, set to Full user authority (opt-in) | `--dangerously-bypass-approvals-and-sandbox` | Your OS user's full authority |

Claude Code and Antigravity use their bypass modes because a headless process cannot reliably stop
and ask for terminal approval. Codex is the one adapter with a real sandbox by default; an operator
may still opt a Codex account into `--dangerously-bypass-approvals-and-sandbox`, the same trade every
other adapter already makes unattended. This is a deliberate availability-versus-containment choice,
not a security boundary supplied by Warmstart. A prompt injection can therefore become arbitrary
commands with your user's file and network access.

⛔ **This is a setting on the account, not on the project (t545).** It used to live in project
settings, gating every adapter a project's tasks could reach alike; an account's own reach into the
machine is a fact about that account, so it now lives on the worker (Settings → Workers →
**Unattended**) and applies to every project that dispatches to it. Choose **Sandboxed only** to hold
a task rather than run it on that account with no real sandbox — if no eligible worker can meet that
requirement, the task holds visibly instead of silently widening its authority. Workers commissioned
before this setting existed retain the mode they have always run unattended work in: **Full user
authority** for every adapter that only ever ran that way, and **Sandboxed adapters only** for Codex,
which has never run any other way until an operator opts it in.

## What Warmstart does bound

- Each account has its own isolation root. Warmstart invokes the vendor's sign-in and never reads,
  copies, stores, or proxies the resulting credential.
- Muse's private XDG root also redirects `gh`; Muse sessions set `GH_CONFIG_DIR` to the
  operator's original GitHub CLI config so `gh` can find the host's keyring account. This grants no
  new OS permission, but makes that existing full-user access usable from `gh`.
- Spawned CLIs receive a restricted environment rather than a copy of `process.env`; Claude and
  Anthropic credential variables are prefix-denied.
- A task mandate limits what the agent may ask the *fleet* to do. It is not an OS sandbox.
- Project checks and finish policy gate landing. Warmstart never creates a commit on an agent's
  behalf and leaves work it declines to land under **Loose ends**.
- Remote phone access uses a separate revocable credential and a smaller API. It cannot administer
  accounts, stop the daemon, or type into a live terminal.

Codex's worktree sandbox must reach the common `.git` directory to commit. That directory contains
the repository's other refs and objects, so this is broader than one task branch. Clone-per-worker
or container isolation is the architectural fix and is not implemented today.

The Codex sandbox is opened to the network (`sandbox_workspace_write.network_access`), because the
finishing instruction asks every agent to fetch the landing target and a sandbox without network
refused that on every run (t493, 2026-09-16). What stays outside it is every credential: the
sandbox's restricted token cannot read Windows Credential Manager, so `gh` runs unauthenticated
there and a `git push` cannot succeed. Pushing is the landing's job, done outside the sandbox with
your credentials, and Warmstart does not hand an agent your GitHub token to change that.

Warmstart currently has no private vulnerability-reporting process. Open a public issue and do not
include secrets or private repository content.
