# Fixtures

Verbatim captures from real CLIs, used by tests that parse rendered output.

- `agy-usage-screen.txt` — Antigravity's `/usage` panel, captured 2026-08-27 from `agy` 1.1.22 driven
  in a real PTY at 120 columns, with ANSI escapes stripped and nothing else changed.
  ⚠️ The account line is **redacted**: the panel prints the signed-in address and a fixture is not a
  place for one. Nothing in the parser reads it.

- `agy-usage-screen-1.3.5.txt` — the same panel, captured 2026-10-14 (t1120) from the `agy` 1.3.5 build
  rewritten in place that day, driven in a real PTY at 120×100 with `/usage` typed at 5s and 12s, and
  ANSI stripped by the same pattern as `stripAnsi`. It is the whole backscroll, startup banner and
  window title included, because the probe parses the whole backscroll. Its rows arrive glued:
  this build places them by cursor address. ⚠️ **Redacted**: the account address, and the user's
  name inside paths.

- `agy-credits-screen.txt` — Antigravity's `/credits` panel, captured 2026-09-04 from `agy` 1.1.26 driven
  in a real PTY at 120 columns, with ANSI escapes stripped and nothing else changed. Shows "Remaining AI Credits: AI Credits not enabled (enable in /settings)".

- `codex-rollout-tail.jsonl` — the three `event_msg` records from a real `codex exec` turn, captured
  2026-08-29 from codex-cli 0.151.0 on a **free** ChatGPT account. The middle one is `token_count`,
  which is where `rate_limits` lives — the **fallback** quota level, used when `codex app-server`'s
  `account/rateLimits/read` cannot be reached (offline, or not signed in).
  ⚠️ The `response_item`, `world_state` and `session_meta` records are **dropped**: they carry the
  prompt, the machine's paths and the account's environment, and the parser reads none of them.
  ⭐ The plan matters to the test — free reports one **30-day** window and a null `secondary`, where
  a paid plan reports a five-hour one, which is why the window id comes from `window_minutes`.

⛔ Captures, never hand-written approximations. A hand-written sample of a screen format proves only
that the parser matches the sample — which is exactly the mistake this file exists to avoid.
