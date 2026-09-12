import { run } from './spawn.js'

/**
 * Telling a stuck run from a slow one.
 *
 * ⛔ **The watchdog could not, and said so.** `runWatchdogs` has reported "no turn for Nm (reported,
 * not stopped — a long tool call looks the same)" since M4, once every ten seconds, and that comment
 * was an honest statement of what elapsed time alone can prove: nothing. A `npm test` and a deadlock
 * produce the same silence.
 *
 * ⭐ **They do not produce the same CPU.** Measured 2026-08-29: two agents each ran this repo's UI
 * suite, both blocked on a DevTools reply that could never arrive, and their process trees used
 * **0.09 seconds of CPU across forty-five minutes**. Work burns CPU; a wait on something that will
 * never come burns none. Silence plus a flat CPU total over a whole tree is a different claim from
 * silence alone, and it is one that can be checked.
 *
 * ⛔ **Nothing in this file kills anything or changes a task's status.** It reads process tables and
 * does arithmetic; every consequence is the scheduler's. ⚠️ A run genuinely blocked on the network —
 * a slow API call, a stalled download — also burns no CPU, which is why one verdict is only ever
 * reported.
 *
 * ⭐ **Two verdicts are a different claim, and the owner's call (2026-09-11) is to act on them.** The
 * first stuck reading is reported and nothing else; if the tree is *still* flat a whole stall window
 * later, `runWatchdogs` parks the task for a person (`stallConfirmed`). Nothing is killed even then —
 * parking closes the run as `blocked` and lands, commits and discards nothing.
 */

export interface ProcessRow {
  pid: number
  ppid: number
  name: string
  /** The full command line where the platform gives one. ⚠️ Null on a process we may not read. */
  command: string | null
  cpuSeconds: number
}

export interface TreeSample {
  at: number
  cpuSeconds: number
  processes: ProcessRow[]
}

/** How far apart two samples must be before their difference means anything. */
export const MIN_SAMPLE_GAP_MS = 60_000
/** CPU seconds a whole tree must accumulate between samples to count as working. */
export const MIN_PROGRESS_CPU_SECONDS = 1

/**
 * Has this tree done anything since the last look?
 *
 * ⚠️ **A drop is progress, not a stall.** The total only covers processes that are still alive, so a
 * child finishing makes it fall. Reading that as "no progress" would report a stall at the exact
 * moment a long tool call completed — the one moment it is certainly working.
 */
export function looksStuck(
  previous: TreeSample | null,
  current: TreeSample,
  opts: { minGapMs?: number; minCpuSeconds?: number } = {}
): boolean {
  const minGapMs = opts.minGapMs ?? MIN_SAMPLE_GAP_MS
  const minCpuSeconds = opts.minCpuSeconds ?? MIN_PROGRESS_CPU_SECONDS

  // ⛔ One sample is a reading, not a trend. The first look establishes the baseline and accuses
  //    nobody: a run that had been working hard for an hour has a large total and no history.
  if (!previous) return false
  if (current.processes.length === 0) return false
  if (current.at - previous.at < minGapMs) return false
  if (current.cpuSeconds < previous.cpuSeconds) return false
  return current.cpuSeconds - previous.cpuSeconds < minCpuSeconds
}

/**
 * How long after a reported stall the second reading is taken.
 *
 * ⚠️ A whole stall window, not the 60s `MIN_SAMPLE_GAP_MS` the first verdict needs. The two readings
 * are doing different jobs: the first has to be confident enough to *mention*, the second to *act*,
 * and the cheapest way to buy that confidence is time. A tool call that was going to come back has
 * twenty-four minutes of total silence to do it in.
 */
export const STALL_CONFIRM_AFTER_MS = 12 * 60 * 1000

/**
 * The second reading, and the one something happens on.
 *
 * ⛔ **The same arithmetic as the first verdict, deliberately.** There is no cleverer test available:
 * what makes this one strong enough to act on is that the tree was already flat for a stall window
 * when it was reported, has had `STALL_CONFIRM_AFTER_MS` to move since, and still has not. ⚠️ The
 * baseline must be the *reported* sample rather than the newest one, or a run sampled every minute
 * would be compared against a minute of its own silence and confirmed far too early.
 *
 * ⭐ A tree that used even a second of CPU in that window is not confirmed, and the entry starts over
 * from the new sample: the bar is met by doing nothing at all, which is what t366's hung `agy` did
 * for thirty-two minutes and what a compiling test suite never does.
 */
export function stallConfirmed(
  reported: TreeSample,
  current: TreeSample,
  opts: { minGapMs?: number; minCpuSeconds?: number } = {}
): boolean {
  // ⚠️ Spelled out rather than spread: an `opts` carrying an explicit `undefined` would otherwise
  // fall all the way back to the 60s first-verdict gap, which is the one value this must not use.
  return looksStuck(reported, current, {
    minGapMs: opts.minGapMs ?? STALL_CONFIRM_AFTER_MS,
    minCpuSeconds: opts.minCpuSeconds ?? MIN_PROGRESS_CPU_SECONDS
  })
}

/**
 * When the silence being judged actually began.
 *
 * ⛔ **`lastRequestStartedAt` alone is a property of the conversation, not of this run**, and on a
 * resumed one it can predate the run by most of a day. Measured on t105, 2026-09-02: a conversation
 * idle since the previous evening was resumed at 06:51, and seventy seconds later the watchdog
 * announced *"no turn for 947m"* about a run that was barely a minute old. Every later number in
 * that report was drawn from the same false premise.
 *
 * ⭐ A landed compaction counts as a turn, because it is one: the boundary is proof the session did
 * the expensive work it was asked to do, whatever the request clock says.
 *
 * ⛔ **And a turn that has not ended yet is still a turn.** `lastRequestStartedAt` is written when a
 * turn *ends*, so on an adapter that takes one prompt and then works — `streamPrompts: 'once'`, and
 * the stream-metered ones in general — it does not move for the whole of a long agentic turn, however
 * many model calls that turn makes. The clock the fleet already keeps for exactly this,
 * `lastActivityAt` (`lastRequestEvidenceAt`, stamped by every mid-turn stream record and read by
 * `touchCacheClock`), is the missing input: without it this function dates the silence from the run's
 * dispatch and the number it hands a report is not the silence, it is the run's age.
 *
 * ⚠️ **Measured, t366 on 2026-09-11.** An `antigravity-cli` run worked for twelve minutes — 60 steps
 * and nine model responses in its conversation — and recorded **no turn at all**, because `agy`
 * reports usage per model call into an accumulator and only writes a turn on its terminal `result`.
 * The watchdog therefore announced *"no turn for 12m"* about a run that was working (its CPU check,
 * which is the half that does not depend on this clock, said so and held the report back), and when
 * the agent really did hang minutes later it announced *"no turn for 13m"* for a silence that was
 * about two minutes old. Both numbers came from this function having nothing newer than the dispatch
 * to read.
 *
 * ⚠️ In memory, so a daemon restart loses it and this falls back to the durable clock. That is the
 * safe direction: the floor is gone, not wrong.
 *
 * ⚠️ The floors only ever move the start of the silence *forward*, so this cannot hide a genuine
 * stall - a run that has been open and quiet for twenty minutes still reads as twenty minutes.
 */
export function quietSince(inputs: {
  /** The last request this session started, or null if it has never started one. */
  lastRequestStartedAt: number | null
  /** When the session process opened. */
  sessionStartedAt: number
  /** When the run being judged was dispatched. A run cannot have been silent longer than it exists. */
  runStartedAt?: number | null
  /** When this session last finished compacting, if ever. */
  compactionLandedAt?: number | null
  /**
   * The newest mid-turn evidence that a model request was under way, or null where there is none —
   * a PTY session, a session this daemon did not start, or a turn that has produced nothing yet.
   */
  lastActivityAt?: number | null
}): number {
  return Math.max(
    inputs.lastRequestStartedAt ?? inputs.sessionStartedAt,
    inputs.runStartedAt ?? 0,
    inputs.compactionLandedAt ?? 0,
    inputs.lastActivityAt ?? 0
  )
}

/** Every process descended from `rootPid`, the root included. */
export function descendantsOf(all: ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of all) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }
  const found: ProcessRow[] = []
  const seen = new Set<number>()
  const stack = [rootPid]
  while (stack.length) {
    const pid = stack.pop()
    // ⚠️ `seen` guards a cycle. Pid reuse can make a process appear to be its own ancestor, and this
    // walk runs on a machine the fleet does not control.
    if (pid === undefined || seen.has(pid)) continue
    seen.add(pid)
    const self = all.find((p) => p.pid === pid)
    if (self) found.push(self)
    for (const child of children.get(pid) ?? []) stack.push(child.pid)
  }
  return found
}

/** ⚠️ 100-nanosecond ticks, which is what `Win32_Process` counts CPU in. */
const WINDOWS_TICKS_PER_SECOND = 10_000_000

export function parseWindowsProcesses(json: string): ProcessRow[] {
  const parsed: unknown = JSON.parse(json)
  // ⚠️ `ConvertTo-Json` emits a bare object when there is exactly one result, never a one-element
  // array. A machine with one process is not realistic; a *filtered* query returning one is.
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const rows: ProcessRow[] = []
  for (const item of list) {
    const r = item as Record<string, unknown>
    const pid = Number(r.ProcessId)
    if (!Number.isFinite(pid)) continue
    // ⚠️ UInt64 crosses the wire as a number or a string depending on its size. Both are read.
    const ticks = Number(r.KernelModeTime ?? 0) + Number(r.UserModeTime ?? 0)
    rows.push({
      pid,
      ppid: Number(r.ParentProcessId ?? 0),
      name: typeof r.Name === 'string' ? r.Name : '',
      command: typeof r.CommandLine === 'string' ? r.CommandLine : null,
      cpuSeconds: Number.isFinite(ticks) ? ticks / WINDOWS_TICKS_PER_SECOND : 0
    })
  }
  return rows
}

/** `ps -eo pid=,ppid=,time=,args=` — `[[DD-]HH:]MM:SS` in the third column. */
export function parsePosixProcesses(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m?.[1] || !m[2] || !m[3]) continue
    const command = (m[4] ?? '').trim()
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: command.split(/\s/)[0]?.split(/[/\\]/).pop() ?? '',
      command,
      cpuSeconds: parsePosixCpuTime(m[3])
    })
  }
  return rows
}

export function parsePosixCpuTime(value: string): number {
  const [days, rest] = value.includes('-') ? value.split('-') : ['0', value]
  const parts = (rest ?? '').split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return 0
  // Right-aligned: seconds last, then minutes, then hours.
  const seconds = parts.reverse().reduce((total, part, i) => total + part * 60 ** i, 0)
  return seconds + Number(days) * 86_400
}

/**
 * Read one sample of a process tree.
 *
 * ⚠️ Returns null rather than throwing on every failure — a thin PATH, a denied query, a pid that
 * has already gone. **Not being able to measure is not evidence of a stall**, and a watchdog that
 * treated it as one would report every run on a machine where the query does not work.
 */
export async function sampleProcessTree(rootPid: number): Promise<TreeSample | null> {
  try {
    const all =
      process.platform === 'win32'
        ? parseWindowsProcesses(
            (
              await run(
                'powershell.exe',
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,' +
                    'KernelModeTime,UserModeTime,CommandLine | ConvertTo-Json -Compress'
                ],
                { timeout: 20_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }
              )
            ).stdout
          )
        : parsePosixProcesses(
            (await run('ps', ['-eo', 'pid=,ppid=,time=,args='], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }))
              .stdout
          )
    const processes = descendantsOf(all, rootPid)
    return {
      at: Date.now(),
      cpuSeconds: processes.reduce((total, p) => total + p.cpuSeconds, 0),
      processes
    }
  } catch {
    return null
  }
}

/**
 * What to show a person who has to decide whether to intervene.
 *
 * ⚠️ The command line, truncated, because the *name* is what every one of these processes has in
 * common and the arguments are what tells them apart: six `electron.exe` rows say nothing, while
 * `electron.exe … --remote-debugging-port=9444` says everything.
 */
export function describeTree(sample: TreeSample, limit = 8): string {
  const listed = [...sample.processes]
    .sort((a, b) => b.cpuSeconds - a.cpuSeconds)
    .slice(0, limit)
    .map((p) => `  pid ${p.pid} · ${p.cpuSeconds.toFixed(1)}s CPU · ${(p.command ?? p.name).slice(0, 120)}`)
  const more = sample.processes.length - listed.length
  return listed.join('\n') + (more > 0 ? `\n  … and ${more} more` : '')
}
