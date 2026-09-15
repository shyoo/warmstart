import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Attachment } from '@shared/tasks.js'
import { museCode, parseResetTime } from './muse-code.js'
import {
  gitEnvFor,
  honoursPosixModes,
  hostExec,
  hostFor,
  hostPath,
  hostScript,
  shQuote,
  type CliHost
} from './clihost.js'

/**
 * Muse Code, and the host bridge it is the first adapter to need.
 *
 * ⛔ Every fixture here is text this CLI actually produced on 2026-09-06, not text somebody thought
 * it would produce — `transient_docs/muse_code_findings_2026-09-06.md` is the capture. That is the
 * whole reason this file exists: a capability table is easy to write and expensive to be wrong
 * about, and the three things that would have failed on the first spawn (no stdin prompt, usage
 * only in the session log, a worktree WSL git cannot open) were all invisible from the vendor's
 * documentation.
 */

const WSL: CliHost = { kind: 'wsl', wsl: 'C:\\Windows\\System32\\wsl.exe' }
const NATIVE: CliHost = { kind: 'native', path: '/home/me/.local/bin/muse' }

describe('hostPath', () => {
  it('translates a Windows path for a bridged host and leaves a native one alone', () => {
    expect(hostPath(WSL, 'C:\\Dev\\ws1')).toBe('/mnt/c/Dev/ws1')
    expect(hostPath(WSL, 'D:\\a b\\c')).toBe('/mnt/d/a b/c')
    expect(hostPath(WSL, 'C:\\')).toBe('/mnt/c')
    expect(hostPath(NATIVE, 'C:\\Dev\\ws1')).toBe('C:\\Dev\\ws1')
    expect(hostPath(NATIVE, '/home/me/x')).toBe('/home/me/x')
  })

  it('is idempotent, so a caller may translate twice without harm', () => {
    expect(hostPath(WSL, hostPath(WSL, 'C:\\Dev\\ws1'))).toBe('/mnt/c/Dev/ws1')
  })

  /**
   * ⛔ Refused rather than mangled. A UNC path silently rewritten to something that resolves to a
   * *different* directory is how a worker ends up reading the wrong isolation root.
   */
  it('refuses a UNC path', () => {
    expect(() => hostPath(WSL, '\\\\server\\share\\x')).toThrow(/UNC/)
  })
})

describe('shQuote', () => {
  /**
   * ⛔ Load-bearing, because `wsl.exe -- bash -lc <script> arg…` **drops the trailing positional
   * arguments** — measured, `$#` came back 0 — so every path has to be quoted into the script text
   * where a `$` would otherwise expand. `$RECYCLE.BIN` sits at the root of every Windows volume.
   */
  it('keeps a dollar sign, a space and a quote literal', () => {
    expect(shQuote('C:/$RECYCLE.BIN')).toBe("'C:/$RECYCLE.BIN'")
    expect(shQuote('/mnt/c/a b/c')).toBe("'/mnt/c/a b/c'")
    expect(shQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('hostScript', () => {
  it('exports the environment, drains stdin into the prompt file, then execs', () => {
    const script = hostScript({
      command: 'muse',
      args: ['exec', '--prompt-file', '/mnt/c/r/p.txt'],
      cwd: 'C:\\Dev\\ws1',
      env: { XDG_CONFIG_HOME: '/mnt/c/r/config' },
      stdin: { path: '/mnt/c/r/p.txt' }
    })
    expect(script.split('\n')).toEqual([
      "export XDG_CONFIG_HOME='/mnt/c/r/config'",
      "cat > '/mnt/c/r/p.txt'",
      "exec 'muse' 'exec' '--prompt-file' '/mnt/c/r/p.txt'"
    ])
  })

  /**
   * ⛔ `exec`, so the handle the daemon holds is the agent's own pid. Without it an interrupt and a
   * reap would land on a shell wrapper while the agent carried on holding the account.
   */
  it('always execs, even with nothing to export and no stdin to drain', () => {
    const script = hostScript({ command: 'muse', args: [], cwd: 'C:\\x', env: {} })
    expect(script).toBe("exec 'muse'")
  })
})

describe('hostExec', () => {
  /**
   * ⛔ **The whole of t268.** `wsl.exe -- muse --version` answers
   * `/bin/bash: line 1: muse: command not found` — measured 2026-09-07 — because the launcher lives
   * in `~/.local/bin`, which `~/.profile` puts on `PATH` and a bare `wsl.exe --` never reads. So
   * `isInstalled()` and `detect()` said *no* for a CLI that runs perfectly, a task pinned to that
   * worker was held with *"Muse Code is not installed"*, and the quota probe — which has always gone
   * through `hostPlan`'s `bash -lc` — read that same account's windows in the same minute.
   */
  it('reaches a bridged CLI through a login shell', () => {
    expect(hostExec(WSL, 'muse', ['--version'])).toEqual({
      command: 'C:\\Windows\\System32\\wsl.exe',
      args: ['--', 'bash', '-lc', "exec 'muse' '--version'"]
    })
  })

  /** ⚠️ Quoted into the script, for the same reason `hostScript` quotes: `--` args never survive. */
  it('quotes what it is given rather than pasting it into a script', () => {
    const plan = hostExec(WSL, 'muse', ['--config', "/mnt/c/a b/$RECYCLE.BIN/it's"])
    expect(plan.args[3]).toBe("exec 'muse' '--config' '/mnt/c/a b/$RECYCLE.BIN/it'\\''s'")
  })

  /**
   * ⛔ Exported into the script, because nothing crosses the boundary — and it matters *now*: this
   * half only started finding the CLI in t268, and muse's launcher self-updates a 263 MB binary
   * unless it is told not to. A version check that swaps the binary under a running fleet is the
   * thing that variable exists to prevent.
   */
  it('exports what the command needs on the far side of the bridge', () => {
    const plan = hostExec(WSL, 'muse', ['--version'], { MUSE_NO_AUTO_UPDATE: '1' })
    expect(plan.args[3]).toBe("export MUSE_NO_AUTO_UPDATE='1'\nexec 'muse' '--version'")
  })

  /** ⛔ A native host is started directly: there is no boundary, and no shell to pay for. */
  it('runs a native CLI with no shell at all', () => {
    expect(hostExec(NATIVE, 'muse', ['--version'])).toEqual({
      command: '/home/me/.local/bin/muse',
      args: ['--version']
    })
  })
})

describe('gitEnvFor', () => {
  /**
   * ⛔ The one that would have stopped every dispatch. A Windows-made worktree's `.git` holds
   * `gitdir: C:/…`, which git inside WSL resolves *relatively* and cannot find. Measured on this
   * repository, and the first fix was two variables and no file touched.
   *
   * ⛔ **And the one that stopped two landings (t446, t447, 2026-09-14).** Those two variables reach
   * the agent's *whole* environment, so an `npm test` it runs — hundreds of `git init` in temporary
   * directories — re-initialises the trunk instead and writes `core.worktree = /mnt/c/…/ws3` into
   * the trunk's config; every Windows git there then dies with *Invalid path '/mnt'*. A **relative**
   * pointer needs neither variable (measured against WSL git 2.53 the same day), so a workspace
   * carrying one gets nothing, and only a pointer that cannot be made relative still does.
   *
   * ⚠️ Native hosts get nothing: there is no boundary and the pointer is already right.
   */
  it('is empty on a native host', () => {
    expect(gitEnvFor(NATIVE, process.cwd())).toEqual({})
  })

  it('is empty for a directory that is not a repository', () => {
    expect(gitEnvFor(WSL, 'C:\\definitely\\not\\here')).toEqual({})
  })

  /** A trunk beside a pool member, the way `ensureWorkspacePool` lays them out. */
  const layout = (pointer: (gitDir: string) => string): { cwd: string; gitDir: string } => {
    const base = mkdtempSync(join(tmpdir(), 'muse-gitenv-'))
    const gitDir = join(base, 'trunk', '.git', 'worktrees', 'ws1')
    const cwd = join(base, 'pool', 'ws1')
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, '.git'), `gitdir: ${pointer(gitDir)}\n`)
    return { cwd, gitDir }
  }

  it('is empty for a relative pointer, which git on both sides follows with no environment', () => {
    const { cwd } = layout(() => '../../trunk/.git/worktrees/ws1')
    expect(gitEnvFor(WSL, cwd)).toEqual({})
  })

  it('still names the git directory for an absolute pointer, the one spelling WSL cannot open', () => {
    const { cwd, gitDir } = layout((dir) => dir.split('\\').join('/'))
    expect(gitEnvFor(WSL, cwd)).toEqual({ GIT_DIR: hostPath(WSL, gitDir), GIT_WORK_TREE: hostPath(WSL, cwd) })
  })

  it('is empty for an ordinary clone, whose .git is a directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'muse-gitenv-'))
    mkdirSync(join(base, '.git'))
    expect(gitEnvFor(WSL, base)).toEqual({})
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

  it('names the provider response without inventing a remedy', () => {
    const why = museCode.usageUnavailable?.(UNAVAILABLE)
    expect(why).toContain('Currently unavailable')
    expect(why).toContain('No quota reading')
    expect(why).toContain('even after completed work')
    expect(why).not.toContain('give this worker a task')
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
})

/**
 * Whether a `chmod` on a path actually does anything.
 *
 * ⛔ Measured 2026-09-07 on this machine: `mkdir` + `chmod 0700` under
 * `/mnt/c/…/workers/musefirst/data/muse` reports `777` immediately afterwards, because a Windows
 * volume reaches WSL2 over 9p with no `metadata` mount option. It is a fact about the **path**, not
 * the host — the distribution's own ext4 honours modes perfectly.
 */
describe('honoursPosixModes', () => {
  it('says no for anything a bridged host reads off a Windows volume', () => {
    expect(honoursPosixModes(WSL, 'C:/Users/me/AppData/Roaming/x')).toBe(false)
    expect(honoursPosixModes(WSL, 'D:/data')).toBe(false)
    // Already translated, and translating twice is safe — so both spellings answer the same.
    expect(honoursPosixModes(WSL, '/mnt/c/Users/me/x')).toBe(false)
    expect(honoursPosixModes(WSL, '/mnt/d')).toBe(false)
  })

  it('says yes inside the distribution, where modes are real', () => {
    expect(honoursPosixModes(WSL, '/home/me/.local/share')).toBe(true)
    expect(honoursPosixModes(WSL, '/var/tmp/x')).toBe(true)
    // ⚠️ Not every path beginning `/mnt` is a drive: `/mnt/data` is an ordinary directory.
    expect(honoursPosixModes(WSL, '/mnt/data/x')).toBe(true)
    expect(honoursPosixModes(WSL, '/mnt/cdrom')).toBe(true)
  })

  it('says yes on a native host, because there is no boundary to cross', () => {
    expect(honoursPosixModes(NATIVE, '/home/me/.local/share')).toBe(true)
    expect(honoursPosixModes(NATIVE, 'C:/Users/me/AppData')).toBe(true)
  })
})

describe('plan', () => {
  /**
   * ⚠️ Needs a host — muse on `PATH`, or `wsl.exe` to reach it through. On a machine with neither
   * (CI is one) the whole shape is unassertable, so this states that rather than passing vacuously.
   */
  const reachable = hostFor('muse') !== null
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

  it.runIf(reachable)('sends the prompt as a file and takes stdin for it', () => {
    const plan = museCode.plan({
      sessionId: '11111111-1111-4111-8111-111111111111',
      isolationRoot: root,
      cwd,
      transport: 'stream',
      model: 'muse-spark-1.3',
      effort: 'medium'
    })
    // The whole invocation is one shell script, on both hosts.
    const script = plan.args[plan.args.length - 1] ?? ''
    expect(script).toContain('cat > ')
    expect(script).toContain('--prompt-file')
    expect(script).toContain('--session-id')
    expect(script).toContain("'--model' 'muse-spark-1.3'")
    expect(script).toContain("'--reasoning-effort' 'medium'")
    // ⛔ Unattended work runs with nobody to ask, so approvals are settled before the process starts.
    expect(script).toContain("'--approval-mode' 'never'")
    // ⛔ The session log is the meter on this adapter.
    expect(script).not.toContain('--no-session-log')
    // Both XDG roots are exported inside the script, because nothing crosses into a distribution.
    expect(script).toContain('export XDG_CONFIG_HOME=')
    expect(script).toContain('export XDG_DATA_HOME=')
    // ⛔ A self-update swaps a 263 MB binary under a running worker.
    expect(script).toContain("export MUSE_NO_AUTO_UPDATE='1'")
  })

  it.runIf(reachable)('resumes by reusing the conversation’s own id, with no --resume', () => {
    const plan = museCode.plan({
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      resumeFrom: 'bbbbbbbb-2222-4222-8222-222222222222',
      isolationRoot: root,
      cwd,
      transport: 'stream'
    })
    const script = plan.args[plan.args.length - 1] ?? ''
    expect(script).toContain("'--session-id' 'bbbbbbbb-2222-4222-8222-222222222222'")
    expect(script).not.toContain('--resume')
  })

  /**
   * ⛔ **t364, and the refusal is the vendor's, not this app's.** muse compares `--workspace` against
   * the root the session was *opened* in and exits 1 with an empty stdout when they differ —
   * `session <id> was created in workspace <A>; refusing to resume in workspace <B>; pass
   * --workspace <A> or --allow-workspace-switch`. Measured 2026-09-11 against muse 1.1.1 on a
   * `--provider echo` session, so the reading cost nothing: refused without the flag, resumed and
   * re-rooted its tools with it. t364 hit it for real — a conversation opened under the pre-rename
   * `multi_agent_controller_workspaces\ws1`, whose **row** `repointIsolationRoots` had moved to
   * `warmstart_workspaces\ws1` while the vendor's own log still said the old path — and read as the
   * agent failing the task 4.4 seconds after dispatch.
   */
  it.runIf(reachable)('lets a resumed conversation move to the worktree this run claimed', () => {
    const resumed = museCode.plan({
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      resumeFrom: 'bbbbbbbb-2222-4222-8222-222222222222',
      isolationRoot: root,
      cwd,
      transport: 'stream'
    })
    expect(resumed.args[resumed.args.length - 1] ?? '').toContain("'--allow-workspace-switch'")
    // ⚠️ And not on a cold start, where there is no recorded root to disagree with and the flag
    // would only widen what a fresh session may do.
    const cold = museCode.plan({
      sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      isolationRoot: root,
      cwd,
      transport: 'stream'
    })
    expect(cold.args[cold.args.length - 1] ?? '').not.toContain('--allow-workspace-switch')
  })

  /**
   * ⛔ **t289, and it is the host rather than the CLI.** `--image` does not hand muse a path, it
   * makes muse *install* the file into an asset store under `XDG_DATA_HOME` whose mode it insists
   * is `0700`. A Windows volume seen from WSL is 9p without `metadata`: everything reads `0777` and
   * `chmod` is a silent no-op. Measured 2026-09-07 with the real account — data home on ext4, the
   * model answered; data home on `/mnt/c`, `failed to install accepted image asset: asset is
   * corrupt: asset directory permissions must be 0700, got 0777` and **exit 1**, five seconds after
   * dispatch and before the model was called. The run read as the agent having failed the task.
   */
  it.runIf(reachable)('never asks for an image where its asset store cannot be 0700', () => {
    const plan = museCode.plan({
      sessionId: 'eeeeeeee-5555-4555-8555-555555555555',
      isolationRoot: root,
      cwd,
      transport: 'stream',
      attachments: [png('/attachments/one.png'), png('/attachments/two.png')]
    })
    const script = plan.args[plan.args.length - 1] ?? ''
    const dataHomeIsWindowsVolume = /export XDG_DATA_HOME='\/mnt\//.test(script)
    if (dataHomeIsWindowsVolume) {
      // ⛔ Not "fewer images" — none, and no stray path left in the argv either.
      expect(script).not.toContain('--image')
      expect(script).not.toContain('one.png')
    } else {
      expect(script.match(/'--image'/g)).toHaveLength(2)
    }
  })

  /**
   * The invariant, stated without reference to the predicate that implements it: whatever host this
   * runs on, those two things may never appear in the same script.
   */
  it.runIf(reachable)('so a Windows data home and an --image flag never share a script', () => {
    const plan = museCode.plan({
      sessionId: 'ffffffff-6666-4666-8666-666666666666',
      isolationRoot: root,
      cwd,
      transport: 'stream',
      attachments: [png('/attachments/one.png')]
    })
    const script = plan.args[plan.args.length - 1] ?? ''
    expect(/export XDG_DATA_HOME='\/mnt\//.test(script) && script.includes('--image')).toBe(false)
  })

  it.runIf(reachable)('still takes a folder as a path in the prompt, never as an image', () => {
    const plan = museCode.plan({
      sessionId: '99999999-7777-4777-8777-777777777777',
      isolationRoot: root,
      cwd,
      transport: 'stream',
      attachments: [{ ...png('/attachments/ctx'), kind: 'folder', mediaType: 'inode/directory' }]
    })
    const script = plan.args[plan.args.length - 1] ?? ''
    expect(script).not.toContain('--image')
  })

  it.runIf(reachable)('opens a plain TUI for a probe, with no exec and no prompt file', () => {
    const plan = museCode.plan({
      sessionId: 'cccccccc-3333-4333-8333-333333333333',
      isolationRoot: root,
      cwd,
      transport: 'pty'
    })
    const script = plan.args[plan.args.length - 1] ?? ''
    expect(script).not.toContain('cat > ')
    expect(script).not.toContain("'exec' '--json'")
    expect(script).toContain("'--approval-mode' 'on-request'")
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
