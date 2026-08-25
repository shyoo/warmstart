# orchestratord — not built yet (M1)

The long-lived process that actually runs the fleet: scheduler, quota ledger, cache clock, dependency
DAG, worker pool and adapters, the resource broker, the transcript tailer, SQLite, and the MCP server
the controller agent connects to.

It lives outside Electron on purpose. The premise of the tool is unattended progress across quota
windows — overnight, across a 5-hour reset — so closing the UI must stop nothing. Keeping the native
modules (`node-pty`, `better-sqlite3`) here rather than in the renderer also means an Electron
upgrade cannot break a running fleet.

Design: `transient_docs/implementation_plan_2026-08-24.md` §6.1.
