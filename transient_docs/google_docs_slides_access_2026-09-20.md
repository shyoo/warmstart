# Can a Warmstart agent create/write a Google Slide or Doc? (2026-09-20)

**Answer: not natively. Possible today with zero Warmstart code changes, via each CLI's own MCP
support — but that path is invisible to Warmstart and inherits the fleet's unattended-bypass
authority with no extra gate. A first-class version would need real engineering; sketched below.**

## What was checked

- `docs/adapters.md`'s fleet table and per-adapter capability rows — none of `claude-code`,
  `antigravity-cli` (agy), `openai-compatible` (codex), `muse-code` or `local-llm` declares any
  Google Workspace / Drive / Slides capability. All five are coding agents: file edit, shell, git,
  and (for some) a view/image tool. Nothing calls a Google API out of the box.
- `docs/mcp.md` and `src/daemon/mcpconfig.ts` (`writeMcpConfig`) — Warmstart's **own** MCP server
  (`mcp__warmstart__*`) is a fixed, two-tier tool set (`task_read`, `ask_human`, `land_work`, …) for
  managing tasks/runs. It has no notion of a third-party integration and cannot be extended with one
  short of editing `mcpconfig.ts` — the config object it writes has exactly one entry, keyed
  `MCP_SERVER_NAME = 'warmstart'`.
- `src/daemon/adapters/claude-code.ts:1130` — the per-session config file is passed as
  `--mcp-config <path>`, **without** `--strict-mcp-config`. Claude Code's own documented behaviour
  for that flag is additive: it merges the given file with whatever is already registered at
  user/project scope in that session's `CLAUDE_CONFIG_DIR` (via `claude mcp add`). So a session
  Warmstart spawns is not sealed to only the tools `mcpconfig.ts` writes.
- `docs/adapters.md` fleet table, row "Warmstart MCP tools": `claude-code` ✔, `antigravity-cli` and
  `openai-compatible` "⛔ global registration only", `muse-code` "`mcpServers` is per-**root** config,
  not per session". Warmstart never wires *its own* tools into those three at the session level at
  all — but that also means it never touches or restricts whatever the CLI's own global MCP config
  already holds for that isolation root.

Put together: **the general MCP protocol each CLI supports (register any server, e.g. a Google
Workspace one) is a different, more permissive mechanism than Warmstart's own internal tool server**,
and Warmstart neither blocks nor mediates it today.

## What's possible right now, with no code change

1. Pick a worker/isolation root (its `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, or muse's `XDG_CONFIG_HOME` —
   whichever adapter is used).
2. Install and register a Google Workspace MCP server (a third-party server exposing Docs/Slides/
   Drive create-and-edit tools over OAuth) at **user scope** in that config directory, e.g.
   `claude mcp add --scope user google-workspace -- <command> <args>`, and complete its one-time
   Google OAuth consent interactively.
3. Every subsequent Warmstart-spawned session for that worker/adapter additively picks up those
   tools, because step 3 above never restricts the merge.
4. Ask the agent, in an ordinary Warmstart task/conversation, to create the deck. It calls the
   Google MCP server's tools directly — Warmstart just sees another tool call in the transcript.

This needs no Warmstart engineering. It is, however, entirely outside Warmstart's model: the
capability table doesn't know it exists, there's no UI to turn it on/off, and — the important part —

## The risk this surfaces

Per `docs/security.md` and the t545/t580 history in `HANDOFF.md`, unattended `work` dispatch on
every adapter here already runs at full-user or workspace-write **bypass** authority: there is no
per-tool approval step once a task is dispatched headless. A Google MCP server registered the way
above would let an unattended agent create, edit, or delete real Slides/Docs on a real account with
**no approval gate at all** — the same trust model that already lets it run arbitrary shell commands
in its worktree, except the blast radius is now a live Google account rather than a disposable
worktree that gets thrown away on failure. Worth surfacing to whoever owns that account before
anyone wires this up, config-only or not.

## Implementation plan, if this should become a first-class, Warmstart-owned feature

Goal: visibility (it's a real capability the UI and docs know about), a credential story that fits
the project's existing isolation-per-account model, and — the part the config-only hack cannot give
you — an approval gate that survives an unattended-authority worker.

1. **Bundle a first-party Google Workspace MCP server**, the same way `src/mcp/agentyard-mcp.js` is
   bundled today (a small server wrapping Slides `presentations.batchUpdate` / Docs `documents.
   batchUpdate` / Drive `files.create`). Vendoring or wrapping an existing OSS server is fine; the
   point is Warmstart controls the process it spawns and the scopes it requests, rather than trusting
   an operator's arbitrary global registration.
2. **Add a second `mcpServers` entry in `writeMcpConfig`** (`src/daemon/mcpconfig.ts`), gated behind
   a new project- or worker-level setting (parallel to `Worker.unattendedAuthority`, t545). Off by
   default — adding tool definitions changes the prompt-cache prefix for *every* session on that
   tier (§2 of `docs/mcp.md`), so this is a deliberate, visible on/off switch, not a silent default.
3. **Credential storage**: a Google OAuth client + refresh token per worker, stored under that
   worker's own isolation root (parallel to how `CLAUDE_CONFIG_DIR` isolates credentials today) and
   read only by the bundled MCP server process — never exposed as an env var to the model's own shell
   tool. `spawnEnv()`'s prefix-deny model (`CLAUDE*`/`ANTHROPIC*`) is about *this app's* secrets; a
   Google token needs the same treatment (file-based, never copied into the spawned CLI's process
   env) rather than reusing that allowlist.
4. **One-time interactive consent**, triggered from Settings → Workers, parallel to each adapter's
   existing account-commissioning flow.
5. **Approval boundary — the hard part.** `docs/mcp.md`'s `request_directory` pattern is the
   precedent: a tool whose call always reaches a person, regardless of the worker's own bypass
   authority, because a sandbox/permission mode fixes what's grantable *before the first token* and
   cannot be widened mid-flight (`docs/mcp.md` §"request_directory, and why granting one ends the
   run"). The Google tools should route through the same kind of forced-approval RPC the daemon
   already uses for `--permission-prompt-tool`, independent of `bypassPermissions`/`--dangerously-*`.
   ⚠️ **That hook only exists for `claude-code`** (`docs/adapters.md`, "Warmstart MCP tools" row) — no
   other adapter has a working per-call approval callback at all; codex and agy are only ever fully
   sandboxed or fully bypassed. So a real approval gate is only enforceable on `claude-code` today;
   shipping this on the other adapters means shipping it with no gate, which defeats the point. First
   cut should probably be `claude-code`-only, or bundle it only for controller/chat sessions where a
   person is already watching (`docs/mcp.md` §2, "controller tier is handed out only to the chat
   session, where a person is watching").
6. **Docs**: a new adapter capability row in `docs/adapters.md`; a section in `docs/mcp.md`
   distinguishing "Warmstart's fixed internal tool server" from "an optional external MCP
   integration"; a new boundary line in `docs/security.md`.
7. **Scope of a first cut**: create a deck/doc and append text/slides — not full formatting fidelity.

## Recommendation

Don't build the first-class version speculatively. If the immediate need is "make one agent create
one slide deck," the config-only path above works today and costs nothing to try. Build the gated,
first-class version only once someone has actually hit the approval-gate problem in practice (an
unattended task that should not have had unsupervised Slides access) — the same "measure, don't
assert" standard this project holds itself to everywhere else in `docs/adapters.md`.
