# Security model

Warmstart runs coding agents, and coding agents can execute code. Treat every task prompt and every
repository an agent reads as untrusted input until you have decided otherwise.

## Unattended authority

| Adapter | Unattended mode | Effective boundary |
|---|---|---|
| Claude Code | `bypassPermissions` | Your OS user's full authority |
| Antigravity | `--dangerously-skip-permissions` | Your OS user's full authority |
| Codex | `--sandbox workspace-write` | Workspace sandbox, widened to the repository's shared `.git` |

Claude Code and Antigravity use their bypass modes because a headless process cannot reliably stop
and ask for terminal approval. This is a deliberate availability-versus-containment choice, not a
security boundary supplied by Warmstart. A prompt injection can therefore become arbitrary commands
with your user's file and network access.

Choose **Sandboxed only** in project settings to restrict unattended dispatch to adapters with a real
sandbox. If no eligible adapter can meet that requirement, the task holds visibly instead of
silently widening its authority. Projects created before this setting existed retain **Full user
authority**.

## What Warmstart does bound

- Each account has its own isolation root. Warmstart invokes the vendor's sign-in and never reads,
  copies, stores, or proxies the resulting credential.
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

Warmstart currently has no private vulnerability-reporting process. Open a public issue and do not
include secrets or private repository content.
