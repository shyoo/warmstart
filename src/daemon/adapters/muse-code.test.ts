import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Attachment } from '@shared/tasks.js'
import type { SpawnPlan } from './types.js'
import { museBinary, museCode, parseResetTime, trustKey } from './muse-code.js'
import { hostAt, hostPlan, hostScript, shQuote, WINDOWS_DRAIN, type CliHost } from './clihost.js'

/**
 * Muse Code, and the per-platform start-up it is the first adapter to need.
 *
 * ⛔ Every fixture here is text this CLI actually produced on 2026-09-06, not text somebody thought
 * it would produce — `transient_docs/muse_code_findings_2026-09-06.md` is the capture. That is the
 * whole reason this file exists: a capability table is easy to write and expensive to be wrong
 * about, and the three things that would have failed on the first spawn (no stdin prompt, usage
 * only in the session log, a quota that exists only on screen) were all invisible from the vendor's
 * documentation.
 */

describe('hostAt', () => {
  it('names the host by this machine’s own platform', () => {
    expect(hostAt('C:\\m\\muse-bin-1.3.0-R1.exe', 'win32')).toEqual({
      kind: 'windows',
      path: 'C:\\m\\muse-bin-1.3.0-R1.exe'
    })
    expect(hostAt('/usr/local/bin/muse', 'darwin')).toEqual({ kind: 'posix', path: '/usr/local/bin/muse' })
    expect(hostAt('/usr/local/bin/muse', 'linux').kind).toBe('posix')
  })
})

describe('shQuote', () => {
  /** ⛔ A double-quoted string still expands `$`, and a generated path can contain one. */
  it('keeps a dollar sign, a space and a quote literal', () => {
    expect(shQuote('/a/$RECYCLE.BIN')).toBe("'/a/$RECYCLE.BIN'")
    expect(shQuote('/a b/c')).toBe("'/a b/c'")
    expect(shQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('hostScript', () => {
  it('exports the environment, drains stdin into the prompt file, then execs', () => {
    const script = hostScript({
      command: '/usr/local/bin/muse',
      args: ['exec', '--prompt-file', '/r/p.txt'],
      env: { XDG_CONFIG_HOME: '/r/config' },
      stdin: { path: '/r/p.txt' }
    })
    expect(script.split('\n')).toEqual([
      "export XDG_CONFIG_HOME='/r/config'",
      "cat > '/r/p.txt'",
      "exec '/usr/local/bin/muse' 'exec' '--prompt-file' '/r/p.txt'"
    ])
  })

  /**
   * ⛔ `exec`, so the handle the daemon holds is the agent's own pid. Without it an interrupt and a
   * reap would land on a shell wrapper while the agent carried on holding the account.
   */
  it('always execs, even with nothing to export and no stdin to drain', () => {
    const script = hostScript({ command: 'muse', args: [], env: {} })
    expect(script).toBe("exec 'muse'")
  })
})

describe('hostPlan', () => {
  const POSIX: CliHost = { kind: 'posix', path: '/usr/local/bin/muse' }
  const WINDOWS: CliHost = { kind: 'windows', path: 'C:\\m y\\muse-bin-1.3.0-R1.exe' }

  it('runs one script on POSIX, carrying the environment inside it', () => {
    const plan = hostPlan(POSIX, { command: POSIX.path, args: ['--version'], env: { A: '1' } })
    expect(plan.command).toBe('/bin/sh')
    expect(plan.args[0]).toBe('-c')
    expect(plan.args[1]).toContain("export A='1'")
    expect(plan.env).toEqual({})
  })

  /** ⛔ A terminal needs no drain: the TUI is started directly, with no shell and no wrapper. */
  it('starts the Windows executable itself when there is no stdin to drain', () => {
    expect(hostPlan(WINDOWS, { command: WINDOWS.path, args: ['--x'], env: { A: '1' } })).toEqual({
      command: WINDOWS.path,
      args: ['--x'],
      env: { A: '1' }
    })
  })

  /**
   * ⛔ The Windows half of `cat > file; exec`. Arguments travel as an array — a path with a space
   * is one argument, never split by `cmd` — and the runtime is the daemon's own.
   */
  it('puts the daemon’s own runtime in front of the executable on Windows to drain stdin', () => {
    const plan = hostPlan(WINDOWS, {
      command: WINDOWS.path,
      args: ['exec', '--session-id', 'abc'],
      env: { A: '1' },
      stdin: { path: 'C:\\r\\p.txt' }
    })
    expect(plan.command).toBe(process.execPath)
    expect(plan.args).toEqual(['-e', WINDOWS_DRAIN, 'C:\\r\\p.txt', WINDOWS.path, 'exec', '--session-id', 'abc'])
    expect(plan.env).toEqual({ A: '1', ELECTRON_RUN_AS_NODE: '1' })
  })

  /**
   * The drain itself, run for real: stdin becomes the file byte for byte (non-ASCII included), the
   * child's stdout reaches this pipe untouched, its exit code comes back, and it never inherits
   * `ELECTRON_RUN_AS_NODE`. The "agent" here is this same Node, so no CLI is needed.
   */
  it('drains stdin to the file, then runs the command with the pipe and exit code intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-drain-'))
    const file = join(dir, 'prompt file.txt')
    const prompt = 'héllo — 世界\n'
    const agent =
      "const t=require('fs').readFileSync(process.argv[1],'utf8');" +
      'process.stdout.write(JSON.stringify({t,e:process.env.ELECTRON_RUN_AS_NODE??null}));process.exit(7)'
    const result = spawnSync(process.execPath, ['-e', WINDOWS_DRAIN, file, process.execPath, '-e', agent, file], {
      input: prompt,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(result.status).toBe(7)
    expect(readFileSync(file, 'utf8')).toBe(prompt)
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual({ t: prompt, e: null })
  })
})

describe('parseUsage', () => {
  /** Verbatim, 2026-09-06, from the live account under a 100x30 terminal. */
  const PANEL = [
    '',
    '  Muse Code 1.0.3',
    '',
    '  Session usage',
    '',
    '    Input      0',
    '    Cached     0',
    '    Output     0',
    '    Total      0',
    '',
    '    Turns         0',
    '    Subagents  none',
    '',
    '  Subscription · Muse Code Everyday Usage',
    '    Current        5% used · Resets at 1:38 AM',
    '    Weekly         1% used · Resets Sep 13 at 5:00 PM',
    '    as of 9:17 PM',
    ''
  ].join('\n')

  // 2026-09-06 21:17 local, which is what the panel was drawn at.
  const NOW = new Date(2026, 8, 6, 21, 17).getTime()

  it('reads both windows off the panel', () => {
    const windows = museCode.parseUsage?.(PANEL, NOW)
    expect(windows).toEqual([
      { id: '5h', label: 'Muse 5h', percent: 5, resetsAt: new Date(2026, 8, 7, 1, 38).getTime() },
      { id: '7d', label: 'Muse 7d', percent: 1, resetsAt: new Date(2026, 8, 13, 17, 0).getTime() }
    ])
  })

  /**
   * ⛔ The one the operator hit on first launch: `/usage` renders `Session usage` and **no
   * Subscription block at all** until the account has spent a turn. Zeroes there would be believed
   * — a 0%-used account is dispatched to ahead of everything else — so the only honest answer is
   * *no reading*, which the staleness ladder already distrusts correctly.
   */
  it('answers null before the account has spent a turn', () => {
    const early = PANEL.split('\n').slice(0, 13).join('\n')
    expect(early).toContain('Session usage')
    expect(museCode.parseUsage?.(early, NOW)).toBeNull()
  })

  it('answers null for a screen that is not the panel at all', () => {
    expect(museCode.parseUsage?.('', NOW)).toBeNull()
    expect(museCode.parseUsage?.('⟩ /usage', NOW)).toBeNull()
  })

  /** A header with no row it recognises is a rendering this parser does not understand. */
  it('answers null when the block is there and the rows are not', () => {
    expect(museCode.parseUsage?.('  Subscription · Muse Code High Usage\n    as of 9:17 PM', NOW)).toBeNull()
  })

  it('reads a fractional percentage', () => {
    const panel = PANEL.replace('5% used', '12.5% used')
    expect(museCode.parseUsage?.(panel, NOW)?.[0]?.percent).toBe(12.5)
  })

  /**
   * ⛔ **What the daemon is actually handed, and what t266 was really about.** `backscroll` is the
   * raw PTY stream with its escapes stripped, and muse paints with absolute cursor addressing — so
   * every row of the panel arrives on **one line**, separated by runs of spaces where the cursor
   * moved. Verbatim from a probe session on 2026-09-07, only the space runs shortened: the parser
   * that read the tmux capture above found nothing at all in this, and reported a healthy account
   * as unreadable on every probe.
   */
  it('reads the panel out of one line, which is how a PTY delivers it', () => {
    const gap = ' '.repeat(9)
    const oneLine =
      ['Session usage', 'Input      0', 'Cached     0', 'Output     0', 'Total      0'].join(gap) +
      gap +
      ['Turns         0', 'Subagents  none'].join(gap) +
      gap +
      [
        'Subscription · Muse Code Everyday Usage',
        'Current        0% used · Resets at 1:55 PM',
        'Weekly         2% used · Resets Sep 13 at 5:00 PM',
        'as of 9:10 AM'
      ].join(gap)

    expect(oneLine.split('\n')).toHaveLength(1)
    expect(museCode.parseUsage?.(oneLine, NOW)).toEqual([
      { id: '5h', label: 'Muse 5h', percent: 0, resetsAt: new Date(2026, 8, 7, 13, 55).getTime() },
      { id: '7d', label: 'Muse 7d', percent: 2, resetsAt: new Date(2026, 8, 13, 17, 0).getTime() }
    ])
  })

  /**
   * ⚠️ A TUI redraws, so the backscroll holds every frame. The last paint is the current one — and
   * on one line, an unbounded `Resets (.+)$` would have swallowed the rest of the panel with it.
   */
  it('takes the last paint when the screen holds several', () => {
    const frame = (used: number): string =>
      `Subscription · Muse Code Everyday Usage     Current        ${used}% used · Resets at 1:55 PM     ` +
      `Weekly         2% used · Resets Sep 13 at 5:00 PM     as of 9:10 AM`
    const windows = museCode.parseUsage?.(`${frame(0)}    ${frame(7)}`, NOW)
    expect(windows?.[0]?.percent).toBe(7)
    expect(windows?.[0]?.resetsAt).toBe(new Date(2026, 8, 7, 13, 55).getTime())
    expect(windows?.[1]?.percent).toBe(2)
  })

  /** A window with no reset time is a reading, not a failure: `null` is *unknown*. */
  it('keeps the percentage when the reset time is missing', () => {
    const panel = PANEL.replace(' · Resets at 1:38 AM', '')
    const windows = museCode.parseUsage?.(panel, NOW)
    expect(windows?.[0]).toEqual({ id: '5h', label: 'Muse 5h', percent: 5, resetsAt: null })
  })
})

/**
 * ⛔ **What the first probe of a freshly commissioned worker actually reads**, and the reason t266
 * exists: MuseFirst was commissioned, signed in and probed on 2026-09-07, and the probe reported
 * that the panel had not appeared and pointed at a folder-trust dialog. It had appeared and the
 * dialog was answered; the provider had simply published no windows. A later recurrence after
 * completed work proved this state does not identify a never-used credential.
 */
describe('usageUnavailable', () => {
  /** Verbatim, 2026-09-07, from MuseFirst's own isolation root under a 100x30 terminal. */
  const UNAVAILABLE = [
    '',
    '  Muse Code 1.0.3',
    '',
    '  Session usage',
    '',
    '    Input      0',
    '    Cached     0',
    '    Output     0',
    '    Total      0',
    '',
    '    Turns         0',
    '    Subagents  none',
    '',
    '  Subscription · Muse Code Everyday Usage',
    '    Currently unavailable',
    ''
  ].join('\n')

  const NOW = new Date(2026, 8, 7, 8, 45).getTime()

  it('is still no reading, and never a zero', () => {
    expect(museCode.parseUsage?.(UNAVAILABLE, NOW)).toBeNull()
  })

  /**
   * ⚠️ The remedy it may now name, and the one it still may not (t570). Eleven days of
   * `quota_samples` say this state begins at a reset and ends once the window has been spent in, so
   * *probing again* is the advice that cannot work and is the advice this sentence must not give.
   * It points at the warm-up turn instead, and says a turn is what it costs.
   */
  it('names the provider response, and the one remedy that is not another probe', () => {
    const why = museCode.usageUnavailable?.(UNAVAILABLE)
    expect(why).toContain('Currently unavailable')
    expect(why).toContain('No quota reading')
    expect(why).toContain('probing again cannot clear it')
    expect(why).toContain('warm-up turn')
    expect(why).toContain('costs one')
  })

  /**
   * ⚠️ The two failures it must not claim. A screen with no panel on it is the *other* diagnosis —
   * a swallowed keystroke or a session still starting — and assigning a provider cause there would
   * send the operator away from a dialog that really is in the way.
   */
  /** ⚠️ One line here too — the `Currently unavailable` panel arrives exactly as the full one does. */
  it('recognises the panel on a single line', () => {
    const oneLine =
      'Turns         0        Subagents  none        Subscription · Muse Code Everyday Usage' +
      '        Currently unavailable'
    expect(museCode.parseUsage?.(oneLine, NOW)).toBeNull()
    expect(museCode.usageUnavailable?.(oneLine)).toContain('Currently unavailable')
  })

  it('says nothing about a screen that is not the panel', () => {
    expect(museCode.usageUnavailable?.('')).toBeNull()
    expect(museCode.usageUnavailable?.('⟩ /usage')).toBeNull()
    expect(museCode.usageUnavailable?.('  Do you trust this workspace?')).toBeNull()
  })

  it('says nothing once the windows are there', () => {
    const panel = UNAVAILABLE.replace(
      '    Currently unavailable',
      '    Current        0% used · Resets at 1:55 PM\n    Weekly         2% used · Resets Sep 13 at 5:00 PM'
    )
    expect(museCode.usageUnavailable?.(panel)).toBeNull()
    expect(museCode.parseUsage?.(panel, NOW)?.map((w) => w.percent)).toEqual([0, 2])
  })
})

describe('parseResetTime', () => {
  const NOW = new Date(2026, 8, 6, 21, 17).getTime()

  /** A bare time is the **next** occurrence of it — which is what a five-hour window means. */
  it('rolls a bare time forward past now', () => {
    expect(parseResetTime('at 1:38 AM', NOW)).toBe(new Date(2026, 8, 7, 1, 38).getTime())
    expect(parseResetTime('at 11:30 PM', NOW)).toBe(new Date(2026, 8, 6, 23, 30).getTime())
  })

  it('reads a dated reset', () => {
    expect(parseResetTime('Sep 13 at 5:00 PM', NOW)).toBe(new Date(2026, 8, 13, 17, 0).getTime())
    expect(parseResetTime('Dec 1 at 12:00 AM', NOW)).toBe(new Date(2026, 11, 1, 0, 0).getTime())
  })

  /** ⛔ Unparsed is unknown. A guessed reset parks a task on a clock nobody set. */
  it('answers null for anything it does not recognise', () => {
    expect(parseResetTime('soon', NOW)).toBeNull()
    expect(parseResetTime('at 25:00', NOW)).toBeNull()
    expect(parseResetTime('Smarch 3 at 1:00 AM', NOW)).toBeNull()
  })
})

describe('decodeStream', () => {
  const decode = (record: Record<string, unknown>) => museCode.decodeStream?.(record)

  /** Verbatim payloads from the captured run. */
  it('reads the model off the configuration record', () => {
    expect(
      decode({
        stream: { kind: 'session', id: '3333' },
        payload_type: 'run.model.configured',
        payload: { model_id: 'muse-spark-1.3-contributor', provider_id: 'meta' }
      })
    ).toEqual({
      kind: 'init',
      sessionId: '3333',
      model: 'muse-spark-1.3-contributor',
      permissionMode: null
    })
  })

  it('reads the assistant text off an output delta', () => {
    expect(decode({ payload_type: 'run.output.delta', payload: { text: 'PONG' } })).toEqual({
      kind: 'assistant_text',
      text: 'PONG'
    })
  })

  /** ⛔ The terminal record. The process exits after it, so nothing else ends the run. */
  it('reads the terminal record as a result', () => {
    expect(
      decode({
        payload_type: 'run.terminal.completed',
        payload: { kind: 'run_terminal', terminal: 'completed', reason: null, text: 'PONG' }
      })
    ).toEqual({
      kind: 'result',
      text: 'PONG',
      costUsd: null,
      isError: false,
      terminalReason: 'completed'
    })
  })

  it('reads any other terminal verdict as an error, with the vendor’s own word for it', () => {
    expect(
      decode({
        payload_type: 'run.terminal.failed',
        payload: { terminal: 'usage_limited', reason: 'usage limit reached', text: null }
      })
    ).toEqual({
      kind: 'result',
      text: 'usage limit reached',
      costUsd: null,
      isError: true,
      terminalReason: 'usage_limited'
    })
  })

  /** ⛔ Keyed on `payload_type`, never on `type` — a Claude-shaped reader sees nothing here. */
  it('ignores a record with no payload_type', () => {
    expect(decode({ type: 'assistant', message: { content: [] } })).toBeNull()
  })

  /**
   * ⛔ t269. Muse's only prose is the final answer — measured, the deltas of a two-tool turn arrived
   * at sequences 47-49 of 67 — so a run's whole working half reaches the peephole through these
   * records or not at all. Payloads below are verbatim from the 2026-09-07 capture.
   */
  describe('the records that say a run is working', () => {
    it('announces a tool the moment it is proposed', () => {
      expect(
        decode({
          payload_type: 'task.lifecycle.proposed',
          payload: {
            kind: 'task_lifecycle',
            event: { kind: 'proposed', task_id: '5f7f82a1', task_kind: 'tool.bash' }
          }
        })
      ).toEqual({ kind: 'assistant_text', text: '· bash\n' })
    })

    it.each([
      ['a model call', 'model.meta.response'],
      ['a plugin reminder', 'reminder.agent.plugin:tbh-reminders:skill-reminder']
    ])('says nothing about %s, which is muse talking to itself', (_label, taskKind) => {
      expect(
        decode({
          payload_type: 'task.lifecycle.proposed',
          payload: { event: { kind: 'proposed', task_id: '6df29c97', task_kind: taskKind } }
        })
      ).toEqual({ kind: 'other', type: 'task.lifecycle.proposed' })
    })

    /** The proposal stays the live indication; no subject on success adds nothing after it. */
    it('stays quiet when a successful tool reports no useful subject', () => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: {
            kind: 'tool_result',
            correlation_facts: { outcome: 'success', tool_name: 'bash' },
            text: '{"exit_code": 0}'
          }
        })
      ).toEqual({ kind: 'other', type: 'tool.result' })
    })

    it('names the command a successful bash tool ran', () => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: {
            correlation_facts: { outcome: 'success', tool_name: 'bash' },
            text: JSON.stringify({ command: 'rg -n "decodeStream" src/daemon' })
          }
        })
      ).toEqual({ kind: 'assistant_text', text: '· bash: rg -n "decodeStream" src/daemon\n' })
    })

    it('names a successful tool’s file target without copying its output', () => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: {
            correlation_facts: { outcome: 'success', tool_name: 'read_file' },
            text: JSON.stringify({ file_path: 'src/daemon/adapters/muse-code.ts', output: 'x'.repeat(1000) })
          }
        })
      ).toEqual({ kind: 'assistant_text', text: '· read_file: src/daemon/adapters/muse-code.ts\n' })
    })

    it('reports a tool that did not succeed', () => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: { correlation_facts: { outcome: 'error', tool_name: 'bash' } }
        })
      ).toEqual({ kind: 'assistant_text', text: '· bash error\n' })
    })

    /**
     * ⛔ t270. Payload verbatim from a live reproduction of the command that produced the report.
     * Naming the command is what turns "a step failed" into something an operator can judge without
     * killing the run to find out.
     */
    it('names the command a failed tool ran', () => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: {
            kind: 'tool_result',
            correlation_facts: { outcome: 'failure', tool_name: 'bash' },
            text:
              '{\n  "chunk_id": "exec-1-1",\n  "command": "echo hello; git config --global does.not.exist",\n' +
              '  "exit_code": 1,\n  "terminal_status": "failed",\n  "output": "hello\\n"\n}'
          }
        })
      ).toEqual({
        kind: 'assistant_text',
        text: '· bash failure: echo hello; git config --global does.not.exist\n'
      })
    })

    it('keeps a long command to one line', () => {
      const decoded = decode({
        payload_type: 'tool.result',
        payload: {
          correlation_facts: { outcome: 'failure', tool_name: 'bash' },
          text: JSON.stringify({ command: `git log ${'-'.repeat(400)}\n  --oneline` })
        }
      })
      const text = (decoded as { text: string }).text
      expect(text).toContain('…')
      expect(text.split('\n').filter(Boolean)).toHaveLength(1)
      expect(text.length).toBeLessThan(160)
    })

    it.each([
      ['a tool whose result is not JSON', 'ok'],
      ['a tool whose result names no command', '{"matches": 0}']
    ])('falls back to the verdict alone for %s', (_label, text) => {
      expect(
        decode({
          payload_type: 'tool.result',
          payload: { correlation_facts: { outcome: 'failure', tool_name: 'grep' }, text }
        })
      ).toEqual({ kind: 'assistant_text', text: '· grep failure\n' })
    })

    /**
     * ⛔ **The whole of t270.** A shell command whose last member exits non-zero — measured, a
     * `git config --global` on a machine that has none, after the useful output was already printed
     * — makes muse emit this while the agent reads the output and carries on. The run then ends
     * `run.terminal.completed` and the process exits 0. Decoded as `error: <reason>` it was the only
     * thing an operator saw all run, and they killed a healthy 24-minute run over it.
     *
     * ⚠️ Its own twin `tool.result` arrives immediately after with the tool and the command, so
     * nothing is lost by staying quiet — and a step failure that really stops the run arrives as a
     * terminal record instead.
     */
    it('never calls a failed step an error of the run', () => {
      expect(
        decode({
          payload_type: 'task.lifecycle.failed',
          payload: {
            kind: 'task_lifecycle',
            event: {
              kind: 'failed',
              reason: 'process exited with status exit status: 1',
              task_id: '9f1e78eb-544d-4d3c-966c-e7a891648a41'
            }
          }
        })
      ).toEqual({ kind: 'other', type: 'task.lifecycle.failed' })
    })

    /** ⛔ The one thing that makes a healthy run genuinely idle, and it lasts up to ten attempts. */
    it('reports a provider retry in the vendor’s own words', () => {
      expect(
        decode({
          payload_type: 'task.lifecycle.status',
          payload: {
            event: {
              kind: 'status',
              message: 'retrying meta model stream in 5000ms (attempt 2/10)',
              details: {
                phase: 'retry_scheduled',
                facets: [
                  {
                    attempt: 1,
                    error_kind: 'rate_limited',
                    http_status: 429,
                    kind: 'external_attempt',
                    max_attempts: 10
                  },
                  { kind: 'producer', detail: { kind: 'provider', provider: 'meta' } }
                ]
              }
            }
          }
        })
      ).toEqual({
        kind: 'assistant_text',
        text: '· retrying meta model stream in 5000ms (attempt 2/10)\n'
      })
    })

    /** ⚠️ `stream_succeeded` rides the same field as the failures; unfiltered it fires per model call. */
    it('stays quiet on the status records that report ordinary progress', () => {
      for (const facets of [
        [{ attempt: 1, kind: 'external_attempt', max_attempts: 10, operation: 'model.response' }],
        [{ attempt: 2, error_kind: 'stream_succeeded', kind: 'external_attempt', max_attempts: 10 }]
      ]) {
        expect(
          decode({
            payload_type: 'task.lifecycle.status',
            payload: {
              event: { kind: 'status', message: 'opening meta model stream attempt 1/10', details: { facets } }
            }
          })
        ).toEqual({ kind: 'other', type: 'task.lifecycle.status' })
      }
    })

    /**
     * ⛔ A 429 muse is already retrying is not the account's quota window. Decoding it as
     * `rate_limit` would feed `recordRateLimit` and bench a worker whose account is fine.
     */
    it('never turns a provider retry into a quota signal', () => {
      const decoded = decode({
        payload_type: 'task.lifecycle.status',
        payload: {
          event: {
            kind: 'status',
            message: 'retrying meta model stream in 5000ms (attempt 2/10)',
            details: { facets: [{ error_kind: 'rate_limited', http_status: 429 }] }
          }
        }
      })
      expect([decoded].flat().map((e) => e?.kind)).not.toContain('rate_limit')
    })
  })
})

describe('decodeTranscript', () => {
  const decode = (record: unknown) => museCode.decodeTranscript?.(record)

  /** Verbatim from the live session log, the turn that read a warm prefix. */
  const RECORD = {
    recorded_at: 1788754289278935,
    record_type: 'event',
    payload_type: 'runtime.session',
    payload: {
      kind: 'run',
      run_id: 'e6d68985',
      source_run_record_id: '33d871da-16bc-4cc1-bed9-c43c3c131e67',
      event: {
        duration_ms: 1495,
        kind: 'model_completed',
        model: 'muse-spark-1.3-contributor',
        usage: {
          cache_read_tokens: 24433,
          cache_write_tokens: 0,
          cached_tokens: 24433,
          input_tokens: 24679,
          output_tokens: 88,
          reasoning_tokens: 75
        }
      }
    }
  }

  /**
   * ⛔ **`input_tokens` includes the cached prefix here.** Measured: 24,679 against a 24,433 cache
   * read, so the model paid for 246 fresh tokens. `contextOf` is written for Anthropic's convention,
   * where the two are kept apart — adding them as they arrive would report a context twice its real
   * size and bill every cache read twice.
   */
  it('splits the cached prefix out of the input count', () => {
    expect(decode(RECORD)).toEqual({
      kind: 'turn',
      turn: {
        requestId: '33d871da-16bc-4cc1-bed9-c43c3c131e67',
        // ⚠️ Microseconds, not milliseconds.
        ts: 1788754289279,
        model: 'muse-spark-1.3-contributor',
        effort: null,
        gitBranch: null,
        inputTokens: 246,
        outputTokens: 88,
        thinkingTokens: 75,
        cacheReadTokens: 24433,
        cacheWrite1hTokens: 0,
        cacheWrite5mTokens: 0,
        contextTokens: 24679
      }
    })
  })

  it('reads a cold first turn', () => {
    const cold = structuredClone(RECORD)
    cold.payload.event.usage = {
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cached_tokens: 0,
      input_tokens: 24532,
      output_tokens: 24,
      reasoning_tokens: 12
    }
    const decoded = decode(cold)
    expect(decoded).toMatchObject({
      kind: 'turn',
      turn: { inputTokens: 24532, cacheReadTokens: 0, contextTokens: 24532 }
    })
  })

  /** ⛔ Never negative: a vendor that changes the convention must not produce a negative context. */
  it('floors the fresh input at zero', () => {
    const odd = structuredClone(RECORD)
    odd.payload.event.usage.input_tokens = 100
    expect(decode(odd)).toMatchObject({ kind: 'turn', turn: { inputTokens: 0, cacheReadTokens: 24433 } })
  })

  /**
   * ⛔ Every other record still reports its timestamp. The tailer uses the previous record's time as
   * the earliest plausible start of the next request, which is what the cache clock counts from —
   * dropping it would be a real loss rather than tidiness.
   */
  it('reports the timestamp of a record it does not meter', () => {
    expect(decode({ recorded_at: 1788754289278935, payload_type: 'session.end', payload: {} })).toEqual({
      kind: 'other',
      ts: 1788754289279
    })
  })

  it('survives a partial or foreign record', () => {
    expect(decode('not an object')).toBeNull()
    expect(decode({ payload_type: 'runtime.session' })).toEqual({ kind: 'other', ts: null })
    expect(
      decode({ payload_type: 'runtime.session', payload: { event: { kind: 'model_completed' } } })
    ).toEqual({ kind: 'other', ts: null })
  })
})

describe('the capability block', () => {
  /**
   * ⛔ These four are not style: each one is a scheduler behaviour that would be wrong if it moved,
   * and each was established by running the CLI rather than by reading its help.
   */
  it('says what was measured', () => {
    const c = museCode.info.capabilities
    // `muse exec` reads its prompt from argv or a file and answers `missing prompt` to stdin.
    expect(c.streamPrompts).toBe('once')
    // Usage is in the session log and nowhere on the `--json` stream.
    expect(c.metering).toBe('transcript')
    // Reusing `--session-id` appends to the conversation and logs `session.resumed`.
    expect(c.resumeSession).toBe(true)
    expect(c.mintsSessionId).toBe(true)
    // The panel is the only place the percentages exist.
    expect(museCode.info.usageRefresh?.answer).toBe('screen')
  })

  /**
   * ⛔ The trailing space is the fix, not a typo. Measured: the slash-command popup swallows the
   * first Enter, and a trailing space closes it so the single carriage return `quota.ts` appends
   * submits the command.
   */
  it('drives `/usage ` with the space that closes the completion popup', () => {
    expect(museCode.info.usageRefresh?.command).toBe('/usage ')
  })

  /** ⚠️ A `screen` refresh needs a parser, and this adapter is the second one to have one. */
  it('carries the parser its refresh mode requires', () => {
    expect(typeof museCode.parseUsage).toBe('function')
  })

  /** The prompt is a file, so what goes down stdin is the prompt itself and not an envelope. */
  it('encodes a prompt as itself', () => {
    expect(museCode.encodeStreamPrompt?.('hello')).toBe('hello')
  })

  /**
   * ⛔ **The one paid probe in the fleet, and the declaration is what makes it exist** (t570). This
   * provider publishes a window only once something has been spent in it, so the warm-up is the
   * only route to a reading on a freshly reset account — and because it costs a turn, the thing
   * being asserted here is that it says so, in the sentence an operator is shown.
   */
  describe('the usage warm-up', () => {
    const warmup = museCode.info.usageRefresh?.warmup

    it('is declared, with a prompt small enough to be worth spending', () => {
      expect(warmup).toBeTruthy()
      expect(warmup?.prompt.length).toBeLessThan(120)
      expect(warmup?.completeMs).toBeGreaterThan(0)
    })

    /**
     * ⛔ It must not need a workspace. A prompt that reads a file fails on a folder this account has
     * not been told it trusts — the dialog that swallows keystrokes — and the turn is spent anyway.
     */
    it('asks about the model itself rather than about anything on disk', () => {
      expect(warmup?.prompt).toMatch(/model/i)
      expect(warmup?.prompt).not.toMatch(/file|repo|directory|folder|read|run/i)
    })

    /** ⚠️ The price, in the operator's own sentence: this is the whole reason the note exists. */
    it('says what it costs, where a person will read it', () => {
      expect(warmup?.note).toContain('real turn')
      expect(warmup?.note).toContain('only ever sent when you ask')
    })
  })
})

/**
 * A fake install, laid out the way each platform's installer leaves one, so `plan()` is asserted on
 * every machine — CI has no Muse — rather than skipped where the CLI is missing.
 *
 * ⚠️ Windows: `MUSE_INSTALL_DIR` holding `.muse-version` and the `muse-bin-<version>.exe` it names,
 * the layout the vendor launcher's own `Get-ActiveBinary` reads. POSIX: an executable `muse` first
 * on `PATH`. Neither file is ever run.
 */
function fakeInstall(): { binary: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'muse-install-'))
  const saved = { MUSE_INSTALL_DIR: process.env.MUSE_INSTALL_DIR, PATH: process.env.PATH }
  let binary: string
  if (process.platform === 'win32') {
    writeFileSync(join(dir, '.muse-version'), '1.3.0-R3401.1\n')
    binary = join(dir, 'muse-bin-1.3.0-R3401.1.exe')
    writeFileSync(binary, '')
    writeFileSync(join(dir, 'muse.cmd'), '@echo off\r\n')
    process.env.MUSE_INSTALL_DIR = dir
  } else {
    binary = join(dir, 'muse')
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)
    process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`
  }
  return {
    binary,
    restore: () => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}

describe('museBinary', () => {
  let install: ReturnType<typeof fakeInstall>
  beforeEach(() => {
    install = fakeInstall()
  })
  afterEach(() => install.restore())

  /**
   * ⛔ On Windows, the real executable and never the `muse.cmd` shim beside it: the shim goes through
   * `cmd` (which splits a path with a space) and a PowerShell launcher that failed outright when
   * started from PowerShell 7, measured 2026-09-19.
   */
  it('finds the active binary, never the shim', () => {
    expect(museBinary()).toBe(install.binary)
    expect(museCode.isInstalled()).toBe(true)
  })

  it.runIf(process.platform === 'win32')('follows .muse-version to the binary it names', () => {
    const dir = process.env.MUSE_INSTALL_DIR ?? ''
    writeFileSync(join(dir, 'muse-bin-1.4.0-R1.exe'), '')
    writeFileSync(join(dir, '.muse-version'), '1.4.0-R1\n')
    expect(museBinary()).toBe(join(dir, 'muse-bin-1.4.0-R1.exe'))
  })

  /** A version file naming a binary that is not there is no install, not a path to a missing file. */
  it.runIf(process.platform === 'win32')('refuses a version file whose binary is missing', () => {
    const dir = process.env.MUSE_INSTALL_DIR ?? ''
    writeFileSync(join(dir, '.muse-version'), '9.9.9-R9\n')
    expect(museBinary()).not.toBe(join(dir, 'muse-bin-9.9.9-R9.exe'))
  })
})

describe('plan', () => {
  let install: ReturnType<typeof fakeInstall>
  beforeEach(() => {
    install = fakeInstall()
  })
  afterEach(() => install.restore())

  const root = join(mkdtempSync(join(tmpdir(), 'muse-plan-')), 'root')
  const cwd = mkdtempSync(join(tmpdir(), 'muse-cwd-'))

  const png = (file: string): Attachment => ({
    id: file,
    messageId: null,
    taskId: null,
    kind: 'image',
    mediaType: 'image/png',
    file,
    bytes: 1,
    width: 1,
    height: 1,
    createdAt: 0
  })

  /**
   * The agent's own argv and environment, whichever platform built the plan: the POSIX script's
   * words and exports, or the Windows drain's trailing arguments and its spawn environment.
   */
  const unwrap = (plan: SpawnPlan): { argv: string[]; env: Record<string, string>; drained: string | null } => {
    if (plan.command === '/bin/sh') {
      const script = plan.args[1] ?? ''
      const env: Record<string, string> = {}
      for (const m of script.matchAll(/^export (\w+)='([^']*)'$/gm)) env[m[1] ?? ''] = m[2] ?? ''
      const exec = script.split('\n').find((l) => l.startsWith('exec ')) ?? ''
      const argv = [...exec.matchAll(/'([^']*)'/g)].map((m) => m[1] ?? '')
      const drained = /^cat > '([^']*)'$/m.exec(script)?.[1] ?? null
      return { argv, env, drained }
    }
    if (plan.args[0] === '-e' && plan.args[1] === WINDOWS_DRAIN) {
      return { argv: plan.args.slice(3), env: plan.env, drained: plan.args[2] ?? null }
    }
    return { argv: [plan.command, ...plan.args], env: plan.env, drained: null }
  }

  const after = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1]

  it('sends the prompt as a file and drains stdin into it', () => {
    const { argv, env, drained } = unwrap(
      museCode.plan({
        sessionId: '11111111-1111-4111-8111-111111111111',
        isolationRoot: root,
        cwd,
        transport: 'stream',
        model: 'muse-spark-1.3',
        effort: 'medium'
      })
    )
    expect(argv[0]).toBe(install.binary)
    expect(argv[1]).toBe('exec')
    expect(drained).not.toBeNull()
    expect(after(argv, '--prompt-file')).toBe(drained)
    expect(after(argv, '--session-id')).toBe('11111111-1111-4111-8111-111111111111')
    expect(after(argv, '--workspace')).toBe(cwd)
    expect(after(argv, '--model')).toBe('muse-spark-1.3')
    expect(after(argv, '--reasoning-effort')).toBe('medium')
    // ⛔ Unattended work runs with nobody to ask, so approvals are settled before the process starts.
    expect(after(argv, '--approval-mode')).toBe('never')
    // ⛔ The session log is the meter on this adapter.
    expect(argv).not.toContain('--no-session-log')
    // ⚠️ Native paths on every platform: nothing is translated any more.
    expect(env.XDG_CONFIG_HOME).toBe(join(root, 'config'))
    expect(env.XDG_DATA_HOME).toBe(join(root, 'data'))
    // ⛔ A self-update swaps the binary under a running worker.
    expect(env.MUSE_NO_AUTO_UPDATE).toBe('1')
  })

  /** The drain is started as Node; the drain itself strips that before the agent starts. */
  it.runIf(process.platform === 'win32')('asks for the daemon runtime as Node only for the drain', () => {
    const plan = museCode.plan({
      sessionId: '12121212-1111-4111-8111-111111111111',
      isolationRoot: root,
      cwd,
      transport: 'stream'
    })
    expect(plan.command).toBe(process.execPath)
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(plan.env.XDG_CONFIG_HOME).toBe(join(root, 'config'))
  })

  it('resumes by reusing the conversation’s own id, with no --resume', () => {
    const { argv } = unwrap(
      museCode.plan({
        sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
        resumeFrom: 'bbbbbbbb-2222-4222-8222-222222222222',
        isolationRoot: root,
        cwd,
        transport: 'stream'
      })
    )
    expect(after(argv, '--session-id')).toBe('bbbbbbbb-2222-4222-8222-222222222222')
    expect(argv).not.toContain('--resume')
  })

  /**
   * ⛔ **t364, and the refusal is the vendor's, not this app's.** muse compares `--workspace` against
   * the root the session was *opened* in and exits 1 with an empty stdout when they differ —
   * `session <id> was created in workspace <A>; refusing to resume in workspace <B>; pass
   * --workspace <A> or --allow-workspace-switch`. Measured 2026-09-11 against muse 1.1.1 on a
   * `--provider echo` session, so the reading cost nothing.
   */
  it('lets a resumed conversation move to the worktree this run claimed', () => {
    const resumed = unwrap(
      museCode.plan({
        sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
        resumeFrom: 'bbbbbbbb-2222-4222-8222-222222222222',
        isolationRoot: root,
        cwd,
        transport: 'stream'
      })
    )
    expect(resumed.argv).toContain('--allow-workspace-switch')
    // ⚠️ And not on a cold start, where there is no recorded root to disagree with and the flag
    // would only widen what a fresh session may do.
    const cold = unwrap(
      museCode.plan({
        sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
        isolationRoot: root,
        cwd,
        transport: 'stream'
      })
    )
    expect(cold.argv).not.toContain('--allow-workspace-switch')
  })

  /**
   * ⭐ Every image, always. The WSL bridge had to drop them — its data home on a Windows volume read
   * `0777` and muse refused the asset store (t289) — and the native build takes them on NTFS,
   * measured 2026-09-19 with a real PNG.
   */
  it('passes every image as --image', () => {
    const { argv } = unwrap(
      museCode.plan({
        sessionId: 'eeeeeeee-5555-4555-8555-555555555555',
        isolationRoot: root,
        cwd,
        transport: 'stream',
        attachments: [png(join(cwd, 'one.png')), png(join(cwd, 'two.png'))]
      })
    )
    expect(argv.filter((a) => a === '--image')).toHaveLength(2)
    expect(argv).toContain(join(cwd, 'one.png'))
  })

  it('still takes a folder as a path in the prompt, never as an image', () => {
    const { argv } = unwrap(
      museCode.plan({
        sessionId: '99999999-7777-4777-8777-777777777777',
        isolationRoot: root,
        cwd,
        transport: 'stream',
        attachments: [{ ...png('/attachments/ctx'), kind: 'folder', mediaType: 'inode/directory' }]
      })
    )
    expect(argv).not.toContain('--image')
  })

  it('opens a plain TUI for a probe, with no exec and no prompt file', () => {
    const { argv, drained } = unwrap(
      museCode.plan({
        sessionId: 'cccccccc-3333-4333-8333-333333333333',
        isolationRoot: root,
        cwd,
        transport: 'pty'
      })
    )
    expect(drained).toBeNull()
    expect(argv[0]).toBe(install.binary)
    expect(argv).not.toContain('exec')
    expect(after(argv, '--approval-mode')).toBe('on-request')
  })

  // ⚠️ Windows only: POSIX `which` augments PATH with the user's own bin directories, where a
  // developer's real install would be found.
  it.runIf(process.platform === 'win32')('refuses to plan where no Muse Code is installed, and says how to install it', () => {
    install.restore()
    const saved = { PATH: process.env.PATH, LOCALAPPDATA: process.env.LOCALAPPDATA }
    process.env.PATH = ''
    process.env.LOCALAPPDATA = mkdtempSync(join(tmpdir(), 'muse-none-'))
    try {
      expect(() => museCode.plan({ sessionId: 'x', isolationRoot: root, cwd, transport: 'stream' })).toThrow(
        /Muse Code was not found/
      )
    } finally {
      process.env.PATH = saved.PATH
      process.env.LOCALAPPDATA = saved.LOCALAPPDATA
    }
  })
})

/**
 * ⛔ Measured 2026-09-19 on 1.3.0: the native Windows build honours a pre-answered trust only under
 * `\\?\` + the fully resolved path — the spelling its dialog prints as *Trust target*. The path as
 * given and the resolved path without the prefix both still drew the dialog.
 */
describe('trustKey', () => {
  it('keeps a POSIX path as given', () => {
    expect(trustKey('/home/me/scratch', 'linux')).toBe('/home/me/scratch')
    expect(trustKey('/Users/me/scratch', 'darwin')).toBe('/Users/me/scratch')
  })

  it.runIf(process.platform === 'win32')('spells a Windows folder the way muse files it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-trust-'))
    expect(trustKey(dir, 'win32')).toBe(`\\\\?\\${realpathSync.native(dir)}`)
  })

  it.runIf(process.platform === 'win32')('still gives a verbatim key for a folder that is not there yet', () => {
    expect(trustKey('C:\\no\\such\\folder', 'win32')).toBe('\\\\?\\C:\\no\\such\\folder')
  })

  it.runIf(process.platform === 'win32')('pre-trusts under that key, beside what is already there', () => {
    const root = mkdtempSync(join(tmpdir(), 'muse-trustroot-'))
    const dir = mkdtempSync(join(tmpdir(), 'muse-trustdir-'))
    mkdirSync(join(root, 'config', 'muse'), { recursive: true })
    const file = join(root, 'config', 'muse', 'trust.json')
    writeFileSync(file, JSON.stringify({ schema_version: 1, projects: { '/mnt/c/old': { decision: 'trusted' } } }))
    museCode.trustDirectory?.(root, dir)
    const projects = (JSON.parse(readFileSync(file, 'utf8')) as { projects: Record<string, unknown> }).projects
    expect(Object.keys(projects).sort()).toEqual(['/mnt/c/old', trustKey(dir)].sort())
  })
})

describe('the transcript path', () => {
  it('is the day-stamped session directory under this root’s own XDG data home', () => {
    const path = museCode.transcriptPath('C:\\r', 'C:\\ws', 'dddddddd-4444-4444-8444-444444444444')
    const now = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    expect(path).toBe(
      join(
        'C:\\r',
        'data',
        'muse',
        'sessions',
        String(now.getFullYear()),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        'dddddddd-4444-4444-8444-444444444444',
        'session.jsonl'
      )
    )
  })
})

describe('failure classifiers', () => {
  /** ⛔ Anchored on measured or vendor-tokened phrases, never on a bare word — `false` is safe. */
  it('recognises an exhausted window without claiming every limit is one', () => {
    expect(museCode.outOfQuota?.('run terminal: usage_limited')).toBe(true)
    expect(museCode.outOfQuota?.('You have hit your usage limit')).toBe(true)
    expect(museCode.outOfQuota?.('tool output limit exceeded')).toBe(false)
    expect(museCode.outOfQuota?.('the agent failed')).toBe(false)
  })

  it('recognises an outage without blaming the account', () => {
    expect(museCode.overloaded?.('HTTP 529 Overloaded')).toBe(true)
    expect(museCode.overloaded?.('503 service unavailable')).toBe(true)
    expect(museCode.overloaded?.('file not found')).toBe(false)
  })

  it('recognises a credential that has to be signed in again', () => {
    expect(museCode.needsReauth?.('auth_rejected')).toBe(true)
    expect(museCode.needsReauth?.('not logged in; run `muse login`')).toBe(true)
    expect(museCode.needsReauth?.('529 overloaded')).toBe(false)
  })
})
