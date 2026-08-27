# Fixtures

Verbatim captures from real CLIs, used by tests that parse rendered output.

- `agy-usage-screen.txt` — Antigravity's `/usage` panel, captured 2026-08-27 from `agy` 1.1.22 driven
  in a real PTY at 120 columns, with ANSI escapes stripped and nothing else changed.
  ⚠️ The account line is **redacted**: the panel prints the signed-in address and a fixture is not a
  place for one. Nothing in the parser reads it.

⛔ Captures, never hand-written approximations. A hand-written sample of a screen format proves only
that the parser matches the sample — which is exactly the mistake this file exists to avoid.
