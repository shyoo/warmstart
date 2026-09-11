/**
 * Strip terminal control sequences out of text that is about to be shown as *prose*.
 *
 * ⛔ Not a retreat from the rule. AGENTS.md forbids parsing ANSI to determine **state**, and nothing
 * here reads anything: this only removes bytes that mean "make the next word dim" from a string a
 * person is going to read in a table cell or a chat bubble. A CLI's last words are the most useful
 * thing a failed dispatch can carry, and they arrive with the colour codes still in them.
 *
 * ⚠️ Measured 2026-08-27: a benched worker's reason rendered as
 * `the agent exited after 3s… It said: ←[2m— claude-sonnet-5 · auto←[0m Your organization has…`,
 * which reads as corruption and buries the one sentence that mattered. And 2026-09-11 (t344/t347):
 * a red check's vitest output reached the thread as `←[31m←[1m FAIL ←[22m←[49m`, which is why this
 * lives in `shared/` — the daemon cleans what it writes, and the renderer cleans what was written
 * before it did.
 */
// eslint-disable-next-line no-control-regex
const ANSI = /[][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}
