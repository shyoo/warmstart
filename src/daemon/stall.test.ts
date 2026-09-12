import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  describeTree,
  descendantsOf,
  looksStuck,
  quietSince,
  parsePosixCpuTime,
  parsePosixProcesses,
  parseWindowsProcesses,
  sampleProcessTree,
  type ProcessRow,
  type TreeSample
} from './stall.js'

const run = promisify(execFile)

/**
 * Telling a stuck run from a slow one.
 *
 * ⛔ **Measured 2026-08-29.** Two agents each ran this repo's UI suite in their own worktree. Both
 * blocked on a DevTools reply that could never arrive, and both were still "running" forty-five
 * minutes later. The watchdog reported *"no turn for 35m (reported, not stopped — a long tool call
 * looks the same)"* once every ten seconds, which was an accurate statement of what elapsed time on
 * its own can prove.
 *
 * ⭐ The two trees had used **0.09 seconds of CPU between them across those forty-five minutes**.
 * That is the number the watchdog was missing: work burns CPU, and a wait on something that will
 * never arrive does not.
 *
 * ⚠️ Pure functions only. The sampling is one `ps` or one `Get-CimInstance` and belongs to the
 * platform; what has to be right is the arithmetic on top of it and the reading of what those two
 * commands emit — which is why the fixtures below are the real shapes, ticks and all.
 */

const sample = (at: number, cpuSeconds: number, processes = 3): TreeSample => ({
  at,
  cpuSeconds,
  processes: Array.from({ length: processes }, (_, i) => ({
    pid: 100 + i,
    ppid: 100,
    name: 'node.exe',
    command: 'node test/ui.test.mjs',
    cpuSeconds: cpuSeconds / Math.max(1, processes)
  }))
})

describe('deciding that a silent run is stuck', () => {
  it('says stuck for the tree that used 0.09s of CPU in forty-five minutes', () => {
    // ⭐ The incident, to scale. Two samples an hour apart, 0.09 CPU-seconds between them.
    const first = sample(0, 0.08)
    const second = sample(45 * 60_000, 0.09)
    expect(looksStuck(first, second)).toBe(true)
  })

  it('accuses nobody on the first look', () => {
    // ⛔ One sample is a reading, not a trend. A run that worked hard for an hour and then went quiet
    //    has a large total and no history, and the total says nothing about the last minute.
    expect(looksStuck(null, sample(Date.now(), 900))).toBe(false)
  })

  it('waits for the samples to be far enough apart to mean anything', () => {
    // ⚠️ The watchdog ticks every 10s. A tree can easily do nothing measurable in that time and be
    //    perfectly healthy, so two samples taken close together are not evidence of anything.
    expect(looksStuck(sample(0, 5), sample(9_000, 5))).toBe(false)
    expect(looksStuck(sample(0, 5), sample(61_000, 5))).toBe(true)
  })

  it('leaves a working tree alone', () => {
    expect(looksStuck(sample(0, 5), sample(120_000, 40))).toBe(false)
  })

  it('reads a falling total as progress, not as a stall', () => {
    // ⛔ The total covers living processes only, so a child finishing makes it drop. Reading that as
    //    "no progress" would report a stall at the exact moment a long tool call *completed* — the
    //    one moment it is certainly working.
    expect(looksStuck(sample(0, 300), sample(120_000, 12))).toBe(false)
  })

  it('says nothing about a tree that no longer exists', () => {
    // ⚠️ Zero processes means the agent is gone, which is a different problem with a different owner.
    //    Reporting it as a stall would send an operator looking for something to kill.
    expect(looksStuck(sample(0, 5), { at: 120_000, cpuSeconds: 0, processes: [] })).toBe(false)
  })

  it('takes its thresholds from the caller, so a slow machine can be given room', () => {
    const before = sample(0, 10)
    const after = sample(120_000, 10.5)
    expect(looksStuck(before, after)).toBe(true)
    expect(looksStuck(before, after, { minCpuSeconds: 0.1 })).toBe(false)
    expect(looksStuck(before, after, { minGapMs: 10 * 60_000 })).toBe(false)
  })
})

describe('finding the processes that belong to a run', () => {
  const tree: ProcessRow[] = [
    { pid: 1, ppid: 0, name: 'init', command: 'init', cpuSeconds: 1 },
    { pid: 10, ppid: 1, name: 'agy.exe', command: 'agy --add-dir ws1', cpuSeconds: 2 },
    { pid: 20, ppid: 10, name: 'node.exe', command: 'node test/ui.test.mjs', cpuSeconds: 0.05 },
    { pid: 30, ppid: 20, name: 'electron.exe', command: 'electron … --remote-debugging-port=9444', cpuSeconds: 2.2 },
    { pid: 31, ppid: 30, name: 'electron.exe', command: 'electron --type=renderer', cpuSeconds: 0.4 },
    { pid: 99, ppid: 1, name: 'chrome.exe', command: 'somebody else entirely', cpuSeconds: 900 }
  ]

  it('walks the whole tree, grandchildren included', () => {
    // ⭐ The incident's shape: the agent's own child was a `node`, whose child was an Electron, whose
    //    children were a renderer and a GPU process. A one-level check would have measured the CPU of
    //    a process that does nothing but wait on the ones below it.
    expect(descendantsOf(tree, 10).map((p) => p.pid).sort((a, b) => a - b)).toEqual([10, 20, 30, 31])
  })

  it('includes the root, because its own CPU counts too', () => {
    expect(descendantsOf(tree, 30).map((p) => p.pid).sort((a, b) => a - b)).toEqual([30, 31])
  })

  it('leaves everything else out, however busy it is', () => {
    // ⛔ pid 99 has 900s of CPU. Summing the machine instead of the run would call every stall
    //    healthy on a developer's own laptop.
    expect(descendantsOf(tree, 10).some((p) => p.pid === 99)).toBe(false)
  })

  it('returns nothing for a pid that has gone', () => {
    expect(descendantsOf(tree, 4242)).toEqual([])
  })

  it('terminates when pid reuse makes a process its own ancestor', () => {
    // ⚠️ This walks a machine the fleet does not control, and a recycled pid can close a loop. A
    //    watchdog that hangs while looking for a hang is not a good watchdog.
    const cyclic: ProcessRow[] = [
      { pid: 7, ppid: 8, name: 'a', command: 'a', cpuSeconds: 1 },
      { pid: 8, ppid: 7, name: 'b', command: 'b', cpuSeconds: 1 }
    ]
    expect(descendantsOf(cyclic, 7).map((p) => p.pid).sort()).toEqual([7, 8])
  })
})

describe('reading what the platform actually prints', () => {
  it('turns Windows 100-nanosecond ticks into seconds', () => {
    // ⚠️ The real shape of `Get-CimInstance Win32_Process | ConvertTo-Json`. 22_000_000 ticks is
    //    2.2 seconds — the figure measured on the stuck Electron on 2026-08-29.
    const rows = parseWindowsProcesses(
      JSON.stringify([
        {
          ProcessId: 30324,
          ParentProcessId: 30160,
          Name: 'electron.exe',
          KernelModeTime: 12_000_000,
          UserModeTime: 10_000_000,
          CommandLine: 'electron.exe C:\\ws1 --remote-debugging-port=9444'
        }
      ])
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.cpuSeconds).toBeCloseTo(2.2, 5)
    expect(rows[0]?.ppid).toBe(30160)
  })

  it('accepts the bare object PowerShell emits for a single result', () => {
    // ⛔ `ConvertTo-Json` does not wrap one result in an array. Assuming an array here would throw on
    //    exactly the machine with the fewest processes to look at.
    const rows = parseWindowsProcesses(
      JSON.stringify({ ProcessId: 5, ParentProcessId: 1, Name: 'node.exe', KernelModeTime: 0, UserModeTime: 0 })
    )
    expect(rows.map((r) => r.pid)).toEqual([5])
    expect(rows[0]?.command).toBeNull()
  })

  it('reads a UInt64 that crossed the wire as a string', () => {
    const rows = parseWindowsProcesses(
      JSON.stringify([{ ProcessId: 5, ParentProcessId: 1, Name: 'n', KernelModeTime: '20000000', UserModeTime: '0' }])
    )
    expect(rows[0]?.cpuSeconds).toBeCloseTo(2, 5)
  })

  it('skips a row with no pid rather than inventing process 0', () => {
    const rows = parseWindowsProcesses(JSON.stringify([{ Name: 'ghost' }, { ProcessId: 9, ParentProcessId: 1 }]))
    expect(rows.map((r) => r.pid)).toEqual([9])
  })

  it('reads the POSIX listing, keeping the arguments that tell processes apart', () => {
    // ⚠️ The command line, not the name: six rows of `electron` say nothing, and the one carrying
    //    `--remote-debugging-port=9444` says everything.
    const rows = parsePosixProcesses(
      ['  501   1 00:02.20 /usr/bin/electron /repo --remote-debugging-port=9444', '  502 501 00:00.05 node test/ui.test.mjs'].join('\n')
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.command).toContain('--remote-debugging-port=9444')
    expect(rows[0]?.name).toBe('electron')
    expect(rows[1]?.ppid).toBe(501)
  })

  it('parses every duration `ps` can print', () => {
    expect(parsePosixCpuTime('00:09')).toBe(9)
    expect(parsePosixCpuTime('01:30')).toBe(90)
    expect(parsePosixCpuTime('01:00:00')).toBe(3600)
    expect(parsePosixCpuTime('2-01:00:00')).toBe(2 * 86_400 + 3600)
  })

  it('reads an unparseable duration as zero rather than as NaN', () => {
    // ⛔ NaN propagates into the sum and makes every comparison false, which would silently disable
    //    the whole check on any platform whose `ps` prints something unexpected.
    expect(parsePosixCpuTime('-')).toBe(0)
    expect(Number.isFinite(parsePosixCpuTime('nonsense'))).toBe(true)
  })

  it('ignores a header or a blank line without producing a row', () => {
    expect(parsePosixProcesses('\n  PID  PPID TIME COMMAND\n')).toEqual([])
  })
})

/**
 * Can this machine enumerate its own processes at all?
 *
 * ⛔ Asked with the platform's own command and **never** through `sampleProcessTree`, because that
 * is the thing under test: routing the probe through it would make the assertions below agree with
 * whatever it did. A denied query and a working one have to be told apart from outside.
 *
 * ⚠️ Not a hypothetical. `Get-CimInstance Win32_Process` is denied inside a sandbox, and t56 met it
 * on 2026-08-30: a codex worker running under `--sandbox workspace-write` got WMI access-denied,
 * read the resulting failure as a regression in the change it was making, and stopped to ask.
 */
async function canEnumerateProcesses(): Promise<boolean> {
  try {
    // ⛔ **The two platforms print different shapes, and each must be counted its own way.** This
    // used to run both through one `Number(stdout)`, which is right for PowerShell and wrong for
    // `ps`: `ps -eo pid=` prints *one pid per line*, so `Number()` of it is `NaN`, `NaN > 0` is
    // `false`, and the helper reported **every** non-Windows host as denied — including hosts where
    // enumeration plainly worked. The test then demanded `sampleProcessTree` answer `null`, it
    // correctly answered a real sample, and the failure read as a regression in the watchdog.
    // ⚠️ It fails identically on macOS, which takes this same branch.
    if (process.platform === 'win32') {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // ⚠️ Selects the same properties the watchdog reads before counting: WMI may permit a
          // bare count while denying `CommandLine`, which would otherwise make this a test of
          // two different host capabilities. It still has to *print a count* — this branch reads
          // it as a number, so listing the objects themselves would parse as `NaN` and report
          // every host as denied.
          '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,' +
            'KernelModeTime,UserModeTime,CommandLine).Count'
        ],
        { timeout: 20_000, windowsHide: true }
      )
      // PowerShell may exit successfully after a denied CIM query while printing `0`. That is not
      // permission to enumerate processes; only a positive count proves the query was allowed.
      return Number(String(stdout).trim()) > 0
    }
    // A denied `ps` exits non-zero and is caught below; a permitted one prints at least this
    // process. Count the lines it printed rather than parsing them as one number.
    const { stdout } = await run('ps', ['-eo', 'pid='], { timeout: 20_000 })
    return String(stdout).split('\n').filter((line) => line.trim() !== '').length > 0
  } catch {
    return false
  }
}

describe('sampling this machine', () => {
  it('finds the process doing the reading, or says it could not look', async () => {
    // ⭐ The one thing the fixtures above cannot prove: that the platform query and the parser agree.
    //    Everything else here is arithmetic on strings somebody typed. ⚠️ Spawns one PowerShell or
    //    one `ps`, which is the same cost the watchdog pays once a minute for a stalled session and
    //    never otherwise.
    //
    // ⛔ **Two contracts, and which one applies is decided by the machine, not by the result.** This
    //    used to assert only the first, which made it an assertion about the *host* — that process
    //    enumeration is permitted here — rather than about this code. In a sandbox that denies the
    //    query it failed, and it failed looking exactly like a regression in whatever change was in
    //    flight. Neither branch skips: a denied environment still has something true to check, and
    //    it is the load-bearing one — `sampleProcessTree` must answer **null**, never an empty
    //    sample, because an empty sample reads as a tree doing nothing, which is a stall.
    const taken = await sampleProcessTree(process.pid)
    if (await canEnumerateProcesses()) {
      expect(taken).not.toBeNull()
      expect(taken?.processes.some((p) => p.pid === process.pid)).toBe(true)
      expect(taken?.cpuSeconds).toBeGreaterThanOrEqual(0)
    } else {
      expect(taken, 'a denied query must read as unmeasurable, not as an idle tree').toBeNull()
    }
  }, 30_000)

  it('returns null for a pid that is not there, rather than an empty reading', async () => {
    // ⛔ Unmeasurable and idle must not be the same value. An empty sample would read as a tree that
    //    is doing nothing, which is the definition of the stall this is looking for.
    const taken = await sampleProcessTree(0x7ffffff)
    expect(taken?.processes ?? []).toEqual([])
  }, 30_000)
})

describe('what the operator is shown', () => {
  it('leads with the busiest and says how many it left out', () => {
    const many: TreeSample = {
      at: Date.now(),
      cpuSeconds: 10,
      processes: Array.from({ length: 12 }, (_, i) => ({
        pid: 100 + i,
        ppid: 100,
        name: 'electron.exe',
        command: `electron.exe --child=${i}`,
        cpuSeconds: i
      }))
    }
    const text = describeTree(many)
    expect(text.split('\n')[0]).toContain('--child=11')
    expect(text).toContain('… and 4 more')
  })

  it('falls back to the name when the command line could not be read', () => {
    // ⚠️ A process whose command line is unreadable is exactly the kind worth listing, so it must not
    //    render as `undefined`.
    const text = describeTree({
      at: 0,
      cpuSeconds: 1,
      processes: [{ pid: 42, ppid: 1, name: 'agy.exe', command: null, cpuSeconds: 1 }]
    })
    expect(text).toContain('agy.exe')
    expect(text).not.toContain('undefined')
  })
})

/**
 * When the silence started.
 *
 * ⛔ Measured on t105, 2026-09-02: a conversation last used the previous evening was resumed at
 * 06:51:03, and at 06:52:15 the watchdog reported *"no turn for 947m"* about a run seventy seconds
 * old. The count was arithmetic on the right field and the wrong premise - `lastRequestStartedAt`
 * belongs to the conversation, which outlives the run being judged.
 */
describe('where the stall clock starts', () => {
  const now = 1_000_000_000

  it('uses the last request when nothing later has happened', () => {
    const lastRequest = now - 20 * 60_000
    expect(
      quietSince({ lastRequestStartedAt: lastRequest, sessionStartedAt: now - 60 * 60_000 })
    ).toBe(lastRequest)
  })

  it('falls back to the session start when no request has ever been made', () => {
    expect(quietSince({ lastRequestStartedAt: null, sessionStartedAt: now - 5000 })).toBe(now - 5000)
  })

  it('⭐ never counts silence older than the run being judged - the t105 reading', () => {
    // The conversation was quiet for 946 minutes. The run had existed for one.
    const quiet = quietSince({
      lastRequestStartedAt: now - 946 * 60_000,
      sessionStartedAt: now - 946 * 60_000,
      runStartedAt: now - 72_000
    })
    expect(Math.round((now - quiet) / 1000)).toBe(72)
  })

  it('counts a landed compaction as a turn, because it is one', () => {
    const landed = now - 30_000
    expect(
      quietSince({
        lastRequestStartedAt: now - 40 * 60_000,
        sessionStartedAt: now - 60 * 60_000,
        runStartedAt: now - 50 * 60_000,
        compactionLandedAt: landed
      })
    ).toBe(landed)
  })

  it('⛔ still reports a genuine stall: the floors only ever move the start forward', () => {
    const lastRequest = now - 20 * 60_000
    const quiet = quietSince({
      lastRequestStartedAt: lastRequest,
      sessionStartedAt: now - 60 * 60_000,
      runStartedAt: now - 55 * 60_000,
      compactionLandedAt: now - 45 * 60_000
    })
    expect(quiet).toBe(lastRequest)
    expect(now - quiet).toBeGreaterThan(12 * 60_000)
  })

  /**
   * ⛔ **t366, 2026-09-11, and it is the same class of error as t105: arithmetic on the wrong
   * premise.** An `antigravity-cli` run worked for twelve minutes — 60 steps and nine model responses
   * in its conversation db — and recorded **no turn**, because `agy` reports usage per model call into
   * `streamusage.ts`'s accumulator and only writes a turn on its terminal `result`. So
   * `lastRequestStartedAt` was null for the whole of it, this function fell through to the run's
   * dispatch, and the watchdog announced *"no turn for 12m"* about a run that was working and then
   * *"no turn for 13m"* about a silence two minutes old. ⚠️ `lastActivityAt` is the clock the cache
   * already trusted for the identical reason (t224, `touchCacheClock`); it was simply never read here.
   */
  it('⭐ counts a mid-turn model call as a turn, because a turn that has not ended is still one', () => {
    const call = now - 90_000
    const quiet = quietSince({
      // Twelve minutes in, with no turn ever recorded: exactly t366's reading.
      lastRequestStartedAt: null,
      sessionStartedAt: now - 12 * 60_000,
      runStartedAt: now - 12 * 60_000,
      lastActivityAt: call
    })
    expect(quiet).toBe(call)
    expect(now - quiet).toBeLessThan(12 * 60_000)
  })

  it('ignores mid-turn evidence that is absent or older than the turn clock', () => {
    const lastRequest = now - 20 * 60_000
    // Null is what a PTY session, or the far side of a daemon restart, hands over.
    expect(
      quietSince({ lastRequestStartedAt: lastRequest, sessionStartedAt: now - 60 * 60_000, lastActivityAt: null })
    ).toBe(lastRequest)
    // ⛔ And it is a floor, never an override: stale evidence cannot un-silence a quiet run.
    expect(
      quietSince({
        lastRequestStartedAt: lastRequest,
        sessionStartedAt: now - 60 * 60_000,
        lastActivityAt: now - 50 * 60_000
      })
    ).toBe(lastRequest)
  })
})
