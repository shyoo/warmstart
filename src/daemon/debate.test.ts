import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { DebateSeat, Principal, Task } from '@shared/tasks.js'

/**
 * Debate's safety boundary, driven where it is cheapest: a temp database, no agent, no prompt and
 * no UI.
 *
 * ⛔ **Four of these rules give a *wrong answer* rather than an error**, which is why they are
 * asserted here rather than trusted to a hand-driven run. A seat filed with session sharing left on
 * reads its neighbour's argument and the blind round is silently not blind. A roster that is a
 * candidate set puts three seats on one account and is still called a debate. A round loop that
 * blocks the organizer before the seats have moved dispatches it into a round that has not
 * happened. And a seat that trips the empty-branch guard parks at `awaiting_human`, which is not a
 * settled status, so the organizer's edges never release and the debate stalls on round 1.
 */

let dir: string
let db: typeof import('./db.js')
let tasks: typeof import('./tasks.js')
let debate: typeof import('./debate.js')

const HUMAN: Principal = { kind: 'human' }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-debate-'))
  process.env.WARMSTART_DATA_DIR = dir
  db = await import('./db.js')
  tasks = await import('./tasks.js')
  debate = await import('./debate.js')
  db.openDb(join(dir, 'debate.db'))
})

beforeEach(() => {
  db.db().exec('delete from task_deps')
  db.db().exec('delete from task_messages')
  db.db().exec('delete from tasks')
})

afterAll(() => {
  db.closeDb()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // A held file handle on Windows is not a test failure.
  }
})

const seat = (workerId: string, model?: string, effort?: string): DebateSeat => ({
  workerId,
  model: model ?? null,
  effort: effort ?? null
})

const ROSTER: DebateSeat[] = [seat('w-a', 'claude-opus-5', 'high'), seat('w-b', 'gpt-5.6')]

function organizer(
  overrides: { seats?: DebateSeat[]; rounds?: number; exchange?: 'full' | 'digest'; maxChildren?: number } = {}
): Task {
  const seats = overrides.seats ?? ROSTER
  return tasks.createTask({
    title: 'Should the scheduler admit a blocked task from the tick or from setStatus?',
    kind: 'debate',
    createdBy: HUMAN,
    status: 'ready',
    mandate: { maxChildren: overrides.maxChildren ?? seats.length },
    debate: {
      seats,
      rounds: overrides.rounds ?? 3,
      exchange: overrides.exchange ?? 'full',
      round: 1,
      verdict: null
    }
  })
}

/** What the daemon does when a seat answers: an `agent` message, then a settled status. */
function answers(seatTask: Task, position: string): void {
  tasks.addMessage(seatTask.id, 'agent', position)
  tasks.setStatus(seatTask.id, 'completed')
}

describe('the roster', () => {
  it('refuses a debate of one — that is an ordinary task, and cheaper', () => {
    const check = debate.validateDebate({ seats: [seat('w-a')], rounds: 2, exchange: 'full' })
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toMatch(/at least 2 seats/)
  })

  // ⛔ One cap, not two: the number the composer offers is the number `createTask` will enforce.
  // A split of six was once refused with a message about a cap nobody had set.
  it('refuses more seats than the task’s own fan-out cap, and names that cap', () => {
    const six = Array.from({ length: 6 }, (_, i) => seat(`w-${i}`))
    const check = debate.validateDebate({ seats: six, rounds: 1, exchange: 'full' })
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toMatch(/fan-out cap of 5/)
  })

  // ⚠️ A homogeneous debate is a thing a one-account operator may want. It is what the composer's
  // heterogeneity notice counts, and a notice is not a gate.
  it('allows a duplicate (worker, model, effort) triple, because that is a homogeneous debate', () => {
    const check = debate.validateDebate({
      seats: [seat('w-a', 'opus', 'high'), seat('w-a', 'opus', 'high')],
      rounds: 1,
      exchange: 'full'
    })
    expect(check.ok).toBe(true)
  })

  it('refuses a seat that names no account, because nothing could be dispatched to it', () => {
    const check = debate.validateDebate({ seats: [seat('w-a'), seat('')], rounds: 1, exchange: 'full' })
    expect(check.ok).toBe(false)
    expect(check.ok === false && check.reason).toMatch(/seat 2 names no account/)
  })

  it('refuses a round budget outside 1–5, and a nonsense exchange rule', () => {
    expect(debate.validateDebate({ seats: ROSTER, rounds: 0, exchange: 'full' }).ok).toBe(false)
    expect(debate.validateDebate({ seats: ROSTER, rounds: 6, exchange: 'full' }).ok).toBe(false)
    expect(debate.validateDebate({ seats: ROSTER, rounds: 2.5, exchange: 'full' }).ok).toBe(false)
    const bad = debate.validateDebate({
      seats: ROSTER,
      rounds: 2,
      exchange: 'verbatim' as unknown as 'full'
    })
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.reason).toMatch(/is not an exchange rule/)
  })
})

describe('opening a debate', () => {
  it('files one seat per roster entry, pinned to exactly that (account, model, effort)', () => {
    const parent = organizer()
    const opened = debate.openDebate(parent.id, HUMAN)
    expect(opened.ok).toBe(true)
    const seats = debate.seatsOf(parent.id)
    expect(seats).toHaveLength(2)
    // ⛔ **A pin, not a candidate set.** `workerIds` is a list the scheduler may pick *from*, so a
    // roster reused as one would let both seats land on the same account and still be a debate.
    expect(seats[0]!.constraints.workerId).toBe('w-a')
    expect(seats[0]!.constraints.workerIds).toEqual(['w-a'])
    expect(seats[0]!.constraints.model).toBe('claude-opus-5')
    expect(seats[0]!.constraints.effort).toBe('high')
    expect(seats[1]!.constraints.workerId).toBe('w-b')
    expect(seats[1]!.constraints.model).toBe('gpt-5.6')
  })

  // ⛔ Two seats of a homogeneous debate satisfy every gate in `sharing.ts` — same project, same
  // account, same model, same effort, clean, room to grow — so with sharing on, seat 2 would be
  // dispatched into the conversation seat 1 had just finished and the blind round would silently
  // not be blind, with a cheaper bill that looks like a win.
  it('files every seat sessionSharing: off, unconditionally, so the blind round is blind', () => {
    const parent = organizer({ seats: [seat('w-a', 'opus', 'high'), seat('w-a', 'opus', 'high')] })
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    for (const s of debate.seatsOf(parent.id)) expect(s.sessionSharing).toBe('off')
  })

  // ⛔ `resolveRange` needs commits to grade and a seat has none, so every seat would enter the
  // review queue and fail out of it. Migration 51's column, used one step earlier than a person
  // ticking it afterwards.
  it('files every seat report-only and nonGradable, because its product is an argument', () => {
    const parent = organizer()
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    for (const s of debate.seatsOf(parent.id)) {
      expect(s.finishPolicy).toBe('report-only')
      expect(s.nonGradable).toBe(true)
      // ⛔ Seats read and argue; they do not write. Turning an agreement into edits is the verdict
      // *Split the work*, which is supported and visible.
      expect(s.mandate.allowed).toEqual(['read'])
    }
  })

  it('blocks the organizer on `settled` edges, so a seat that failed still wakes it', () => {
    const parent = organizer()
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
    const seats = debate.seatsOf(parent.id)
    const edges = db
      .db()
      .prepare('select require from task_deps where task_id = ?')
      .all(parent.id) as Array<{ require: string }>
    expect(edges).toHaveLength(2)
    expect(edges.every((e) => e.require === 'settled')).toBe(true)

    // One failed, one completed: `settled` releases on both, which is the arbitration turn's whole
    // job — reading what came back, including what did not.
    tasks.addMessage(seats[0]!.id, 'agent', 'the tick, because setStatus cannot see a new edge')
    tasks.setStatus(seats[0]!.id, 'completed')
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
    tasks.setStatus(seats[1]!.id, 'failed')
    expect(tasks.requireTask(parent.id).status).toBe('ready')
  })

  it('refuses to seat a task that is not a debate, or one that already has its seats', () => {
    const work = tasks.createTask({ title: 'ordinary work' })
    expect(debate.openDebate(work.id, HUMAN).ok).toBe(false)
    const parent = organizer()
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    const again = debate.openDebate(parent.id, HUMAN)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toMatch(/already has its seats/)
    expect(debate.seatsOf(parent.id)).toHaveLength(2)
  })

  // ⚠️ An organizer blocked on seats that do not exist is a task nothing can ever release, because
  // the thing it waits for was never filed. `applySplit`'s shape, deliberately reused.
  it('unwinds every seat it had filed when one of them cannot be created', () => {
    const parent = organizer({ seats: [seat('w-a'), seat('w-b'), seat('w-c')], maxChildren: 3 })
    // ⚠️ One child of the parent that is **not** a seat, so the third seat runs the parent out of
    // fan-out mid-flight — the cheapest way to make `createTask` throw after two have succeeded,
    // and a real shape rather than a stubbed one.
    tasks.createTask({ title: 'something else this task spawned', parentTaskId: parent.id })

    const opened = debate.openDebate(parent.id, HUMAN)
    expect(opened.ok).toBe(false)
    expect(opened.ok === false && opened.reason).toMatch(/fan-out cap/)

    // ⛔ Nothing is left running, nothing is left depended on, and the organizer was never blocked
    // on an edge that does not exist.
    expect(debate.seatsOf(parent.id)).toHaveLength(0)
    const filed = tasks.listTasks().filter((t) => t.parentTaskId === parent.id && t.title.startsWith('You are one of'))
    expect(filed).toHaveLength(2)
    for (const s of filed) expect(s.status).toBe('cancelled')
    expect(tasks.requireTask(parent.id).status).not.toBe('blocked')
  })
})

describe('the round loop', () => {
  function opened(rounds = 3): { parent: Task; seats: Task[] } {
    const parent = organizer({ rounds })
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    const seats = debate.seatsOf(parent.id)
    answers(seats[0]!, 'Seat one says: admit from the tick. See src/daemon/tasks.ts.')
    answers(seats[1]!, 'Seat two says: admit from setStatus. See src/daemon/scheduler.ts.')
    return { parent: tasks.requireTask(parent.id), seats }
  }

  const briefs = [
    { seat: 1, text: 'address the seven paths that settle a task' },
    { seat: 2, text: 'address the cost of re-reading the whole table on every tick' }
  ]

  /**
   * ⛔ **Re-queue, then block, then admit — and the order is the whole point.** `setStatus`
   * re-admits dependents on the transition *into* a settled status; nothing re-blocks a parent when
   * a dependency goes back *out* of `completed`. So the seats have to leave their settled status
   * first, or the organizer is admitted against seats that have not yet moved.
   */
  it('leaves the organizer blocked and undispatchable at every point between rounds', () => {
    const { parent, seats } = opened()
    expect(tasks.requireTask(parent.id).status).toBe('ready')

    const seen: string[] = []
    const result = debate.nextRound(parent.id, briefs, (taskId) => {
      // The organizer must not be dispatchable while the seats are still moving. It is still
      // `ready` here — which is exactly why the block below has to come *after* this, not before.
      seen.push(taskId)
      tasks.setStatus(taskId, 'ready')
    })
    expect(result.ok).toBe(true)
    expect(seen).toEqual(seats.map((s) => s.id))
    // ⛔ The organizer ends the call blocked, and `admit` — which recomputes from the world rather
    // than trusting the write above — leaves it there because the edges are unmet again.
    expect(tasks.requireTask(parent.id).status).toBe('blocked')
    expect(tasks.requireTask(parent.id).debate?.round).toBe(2)
  })

  // ⛔ In the wrong order the organizer is dispatched into a round that has not happened: blocking
  // first and re-queueing second leaves `admit` reading two settled seats and admitting the parent.
  it('is dispatched into a round that has not happened when the order is reversed', () => {
    const { parent, seats } = opened()
    tasks.setStatus(parent.id, 'blocked')
    tasks.admit(parent.id)
    // The seats have not moved, so every edge is still met and the organizer is `ready` again —
    // which is the failure `nextRound`'s ordering exists to prevent.
    expect(tasks.requireTask(parent.id).status).toBe('ready')
    for (const s of seats) tasks.setStatus(s.id, 'ready')
  })

  /**
   * ⚠️ **The world is what `admit` reads, and this is what that costs.** A caller whose
   * `continueSeat` does not actually move a seat leaves the organizer legitimately dispatchable
   * into a round nobody is answering — it would arbitrate the previous round's positions again and
   * look like it had worked. `nextRound` names it in the log rather than pretending otherwise; this
   * pins the reading so a future refactor cannot make the silence look correct.
   */
  it('is dispatchable again when a seat is not actually re-queued, which is the caller’s bug', () => {
    const { parent } = opened()
    const result = debate.nextRound(parent.id, briefs, () => {
      // Deliberately does nothing: the seats stay `completed`.
    })
    expect(result.ok).toBe(true)
    expect(tasks.requireTask(parent.id).status).toBe('ready')
    // ⛔ And the round still advanced, so a person reading the board sees round 2 with no answers
    // rather than a debate that silently repeated itself.
    expect(tasks.requireTask(parent.id).debate?.round).toBe(2)
  })

  it('sends each seat its own brief, and under `full` every other position verbatim', () => {
    const { parent, seats } = opened()
    debate.nextRound(parent.id, briefs, (taskId) => tasks.setStatus(taskId, 'ready'))
    const toSeatOne = tasks.messagesFor(seats[0]!.id).filter((m) => m.role === 'human').at(-1)?.text ?? ''
    expect(toSeatOne).toContain('address the seven paths that settle a task')
    expect(toSeatOne).not.toContain('address the cost of re-reading')
    // ⚠️ Verbatim, because summarising here would put a fourth model's paraphrase between the
    // debaters and the evidence.
    expect(toSeatOne).toContain('Seat two says: admit from setStatus')
    expect(toSeatOne).toContain('colleagues working on the same problem, not opponents')
  })

  it('hands a `digest` seat the brief alone, and no other position', () => {
    const parent = organizer({ exchange: 'digest' })
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    const seats = debate.seatsOf(parent.id)
    answers(seats[0]!, 'position one')
    answers(seats[1]!, 'position two')
    debate.nextRound(parent.id, briefs, (taskId) => tasks.setStatus(taskId, 'ready'))
    const toSeatOne = tasks.messagesFor(seats[0]!.id).filter((m) => m.role === 'human').at(-1)?.text ?? ''
    expect(toSeatOne).toContain('address the seven paths')
    expect(toSeatOne).not.toContain('position two')
  })

  /**
   * ⛔ **The organizer may stop early and may never extend**, asserted on the stored cap rather
   * than on the prompt. The round count is the budget the operator authorised, and *preference
   * never widens authority* applied to money instead of to a mandate.
   */
  it('refuses a round past the operator’s cap, with the reason and who can lift it', () => {
    const { parent } = opened(1)
    const result = debate.nextRound(parent.id, briefs, () => {
      throw new Error('no seat may be re-queued past the cap')
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toMatch(/authorised for 1 round/)
    expect(result.ok === false && result.reason).toMatch(/Only the operator can buy more rounds/)
    expect(tasks.requireTask(parent.id).debate?.round).toBe(1)
  })

  it('refuses a brief count that does not match the seats, and a seat given two briefs', () => {
    const { parent } = opened()
    const short = debate.nextRound(parent.id, [briefs[0]!], () => undefined)
    expect(short.ok).toBe(false)
    expect(short.ok === false && short.reason).toMatch(/2 seats and you wrote 1 brief/)
    const twice = debate.nextRound(parent.id, [briefs[0]!, { seat: 1, text: 'again' }], () => undefined)
    expect(twice.ok).toBe(false)
    expect(twice.ok === false && twice.reason).toMatch(/was given two briefs/)
    const empty = debate.nextRound(parent.id, [briefs[0]!, { seat: 2, text: '  ' }], () => undefined)
    expect(empty.ok).toBe(false)
    expect(empty.ok === false && empty.reason).toMatch(/brief is empty/)
    // ⛔ None of the three moved the debate on.
    expect(tasks.requireTask(parent.id).debate?.round).toBe(1)
  })
})

describe('the phases', () => {
  it('reads seating, then arbitrating, then executing — from the world, not a column', () => {
    const parent = organizer()
    expect(debate.debatePhaseOf(tasks.requireTask(parent.id))).toBe('seating')
    debate.openDebate(parent.id, HUMAN)
    expect(debate.debatePhaseOf(tasks.requireTask(parent.id))).toBe('arbitrating')
    debate.recordVerdict(parent.id, 'execute')
    expect(debate.debatePhaseOf(tasks.requireTask(parent.id))).toBe('executing')
  })

  it('is null for everything that is not a debate', () => {
    expect(debate.debatePhaseOf(tasks.createTask({ title: 'work' }))).toBeNull()
    expect(debate.debatePhaseOf(tasks.createTask({ title: 'plan', kind: 'plan' }))).toBeNull()
  })
})

describe('the kind transition', () => {
  /**
   * ⛔ **One way, one moment, one caller.** A mutation reachable from `task.update` would be a kind
   * anybody could change on any row, which is precisely the property that makes `kind` safe to
   * branch on in `promptFor` today.
   */
  it('turns a debate into a conversation, once, and writes a line saying it did', () => {
    const parent = organizer()
    expect(debate.becomeConversation(parent.id).ok).toBe(true)
    const after = tasks.requireTask(parent.id)
    expect(after.kind).toBe('conversation')
    // ⚠️ `isOpenConversation` is `kind === 'conversation' && finishPolicy === 'inherit'`, and half
    // of it would be a conversation that still finishes like a debate.
    expect(after.finishPolicy).toBe('inherit')
    expect(tasks.messagesFor(parent.id).some((m) => m.text.includes('now a conversation'))).toBe(true)
  })

  it('refuses the reverse direction and a second application', () => {
    const parent = organizer()
    expect(debate.becomeConversation(parent.id).ok).toBe(true)
    const again = debate.becomeConversation(parent.id)
    expect(again.ok).toBe(false)
    expect(again.ok === false && again.reason).toMatch(/only a debate may become a conversation/)
    const chat = tasks.createTask({ title: 'talk', kind: 'conversation' })
    expect(debate.becomeConversation(chat.id).ok).toBe(false)
    expect(tasks.requireTask(chat.id).kind).toBe('conversation')
  })

  // ⛔ Unreachable from the ordinary task patch: `updateTask` names every column it writes, and
  // `kind` is not among them.
  it('is unreachable from task.update', () => {
    const parent = organizer()
    // ⚠️ Cast through `unknown` on purpose: `kind` is not a member of the patch type, so this is
    // the only way to *try* it — and the point is that the statement `updateTask` writes names
    // every column it touches and this is not one of them.
    tasks.updateTask(
      parent.id,
      { title: 'a new question', kind: 'conversation' } as unknown as Parameters<typeof tasks.updateTask>[1]
    )
    expect(tasks.requireTask(parent.id).kind).toBe('debate')
    expect(tasks.requireTask(parent.id).title).toBe('a new question')
  })
})

describe('the citation check', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'agentyard-cites-'))
    mkdirSync(join(repo, 'src', 'daemon'), { recursive: true })
    writeFileSync(join(repo, 'src', 'daemon', 'tasks.ts'), '// real\n')
  })

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      // Held handle on Windows.
    }
  })

  it('passes a path that exists and flags one that does not', () => {
    const report = debate.citationReport(
      'See src/daemon/tasks.ts and also src/daemon/invented.ts for the answer.',
      repo
    )
    expect(report).toContainEqual({ path: 'src/daemon/tasks.ts', exists: true })
    expect(report).toContainEqual({ path: 'src/daemon/invented.ts', exists: false })
    expect(debate.citationLine(report)).toBe(
      'does not resolve in this repository: src/daemon/invented.ts'
    )
  })

  it('says nothing when every citation resolves — a report, never a penalty', () => {
    expect(debate.citationLine(debate.citationReport('src/daemon/tasks.ts', repo))).toBeNull()
  })

  // ⚠️ A URL matches the shape and is not a claim about this repository, and neither is a path that
  // climbs out of it.
  it('is not fooled by a URL or by a path that escapes the workspace', () => {
    const report = debate.citationReport(
      'per https://arxiv.org/html/2510.20963v1.pdf and ../../etc/shadow.conf',
      repo
    )
    expect(report.some((c) => c.path.includes('arxiv.org'))).toBe(false)
    expect(report).toContainEqual({ path: '../../etc/shadow.conf', exists: false })
  })

  it('reports every citation as unresolved when there is no workspace to check against', () => {
    const report = debate.citationReport('src/daemon/tasks.ts', null)
    expect(report).toEqual([{ path: 'src/daemon/tasks.ts', exists: false }])
  })
})

describe('the agreement', () => {
  const full = {
    agreed: 'admit from setStatus, with the tick as the backstop',
    dissent: 'seat 2 held out for the tick alone, on the cost of the write path',
    confidence: 'high — both seats cited the same seven settle paths',
    unresolved: 'whether the tick backstop can be dropped later'
  }

  it('accepts the four parts', () => {
    const checked = debate.validateAgreement(full)
    expect(checked.ok).toBe(true)
  })

  /**
   * ⛔ **The dissent field is the load-bearing one.** Published work finds consensus-seeking
   * debaters neglect critical disagreements in order to agree, so `converged` may never be allowed
   * to mean *they agreed*.
   */
  it('refuses an empty dissent section, and says what to write instead', () => {
    const checked = debate.validateAgreement({ ...full, dissent: '   ' })
    expect(checked.ok).toBe(false)
    expect(checked.ok === false && checked.reason).toMatch(/may never be/)
    expect(checked.ok === false && checked.reason).toMatch(/what was never contested/)
  })

  it('refuses a missing agreement, confidence or unresolved section', () => {
    expect(debate.validateAgreement({ ...full, agreed: '' }).ok).toBe(false)
    expect(debate.validateAgreement({ ...full, confidence: '' }).ok).toBe(false)
    expect(debate.validateAgreement({ ...full, unresolved: '' }).ok).toBe(false)
  })

  it('renders all four parts, so nothing the organizer was made to write is dropped', () => {
    const rendered = debate.renderAgreement(full)
    for (const part of Object.values(full)) expect(rendered).toContain(part)
  })

  /**
   * ⛔ "None" is the empty dissent wearing a word, and it is how the refusal above was being
   * passed. The floor is the length below which the field says nothing; it is not a quality bar.
   */
  it('refuses a dissent that fits in a breath, and asks for the evidence that withdrew each one', () => {
    for (const short of ['none', 'N/A', 'all agreed', 'no dissent.']) {
      const checked = debate.validateAgreement({ ...full, dissent: short })
      expect(checked.ok).toBe(false)
      expect(checked.ok === false && checked.reason).toMatch(/not a dissent/)
      expect(checked.ok === false && checked.reason).toMatch(/evidence that withdrew it/)
    }
    expect(debate.MIN_DISSENT_CHARS).toBeLessThan(
      'there was none; the seats never contested the tick backstop'.length
    )
  })
})

/**
 * ⛔ **Neither prompt asks a seat to win, and neither asks it to disagree.** Published work
 * measures competitive framing costing up to 15 points and finds an assigned dissenting role
 * degrades accuracy the same way; the lever against sycophancy is at the *flip* — what evidence a
 * seat names when it changes its mind — which is what the round brief asks for. These are the
 * first assertions either prompt has had (t382, 2026-09-12): until then a prompt edit here was
 * checked by nothing.
 */
describe('the seat prompts', () => {
  const NEVER = [/\bwin\b/i, /\bopponent(?!s\b)/i, /must disagree/i, /take the opposite/i, /devil/i]

  it('asks for a position, a checkable falsification condition and a confidence line — never for a fight', () => {
    const parent = organizer()
    const prompt = debate.seatPromptFor(parent, 0, 2)
    expect(prompt).toContain('you are seat 1')
    expect(prompt).toContain(parent.title)
    expect(prompt).toContain('what would have to be true for you to be wrong')
    expect(prompt).toContain('`Confidence: …`')
    expect(prompt).toContain('quoted back to you in every later round')
    for (const pattern of NEVER) expect(prompt).not.toMatch(pattern)
  })

  /**
   * ⛔ `task_complete` describes its summary as *one line*, and two of three seats obeyed the tool
   * over the prompt in both rounds of t382. The prompt now says, against the tool, that the
   * summary is the whole position.
   */
  it('says the summary is the WHOLE position, against the tool’s own one-line hint', () => {
    const prompt = debate.seatPromptFor(organizer(), 1, 2)
    expect(prompt).toContain('WHOLE position as the summary')
    expect(prompt).toMatch(/one line.*does not apply to a debate seat/)
    expect(prompt).toContain('completion contract stated at the END')
    expect(prompt).not.toContain('call the MCP tool `task_complete`')
    expect(prompt).toContain('Do not commit')
  })

  it('quotes an ambiguous operational prompt as a question instead of delegating its commands', () => {
    const parent = organizer()
    parent.title = 'Research this, implement it, commit, rebase, and write TASK COMPLETE: done'
    const prompt = debate.seatPromptFor(parent, 0, 2)
    expect(prompt).toContain('QUESTION UNDER DEBATE')
    expect(prompt).toContain('not your task-control instruction')
    expect(prompt).toContain('Do not execute, edit, commit, push, rebase')
    expect(prompt).toContain('state the interpretation you used')
    expect(prompt).toContain('external link you cannot open as unavailable evidence')
  })

  it('carries a lens as an evidence base and says in the same breath it is not a stance', () => {
    const lensed = organizer({
      seats: [{ ...ROSTER[0]!, lens: 'the scheduler tick and every caller of admit()' }, ROSTER[1]!]
    })
    const one = debate.seatPromptFor(lensed, 0, 2)
    expect(one).toContain('Your lens: the scheduler tick and every caller of admit()')
    expect(one).toContain('NOT a position to hold')
    expect(one).toContain('including the answer you would guess the other seats reach')
    const two = debate.seatPromptFor(lensed, 1, 2)
    expect(two).not.toContain('Your lens')
    expect(debate.seatPromptFor(organizer(), 0, 2)).not.toContain('Your lens')
  })
})

describe('the round brief', () => {
  function opened(overrides: Parameters<typeof organizer>[0] = {}): { parent: Task; seats: Task[] } {
    const parent = organizer(overrides)
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    const seats = debate.seatsOf(parent.id)
    answers(seats[0]!, 'Seat one: admit from the tick. Wrong if setStatus already re-admits. Confidence: 0.7')
    answers(seats[1]!, 'Seat two: admit from setStatus. See src/daemon/scheduler.ts.')
    return { parent: tasks.requireTask(parent.id), seats }
  }

  /**
   * ⭐ Round 1 elicits a falsification condition; until t382 nothing asked whether it had happened,
   * so the check only looked like it was happening. The seat now gets its own words back and is
   * asked what became of them.
   */
  it('quotes the seat its OWN prior position and asks whether its falsification condition was met', () => {
    const { parent, seats } = opened()
    const brief = debate.roundBriefFor(parent, seats, 0, 'address the seven settle paths', 2)
    expect(brief).toContain('Your own position from the previous round, verbatim')
    expect(brief).toContain('Wrong if setStatus already re-admits')
    expect(brief).toContain('Your falsification condition')
    expect(brief).toContain('Has it happened?')
    // ⚠️ Under `full` the other position still travels, and after the seat’s own.
    expect(brief.indexOf('Wrong if setStatus')).toBeLessThan(brief.indexOf('Seat two: admit from setStatus'))
  })

  /**
   * ⛔ The ledger is where the flip gets its evidence named, and "they argued it better" is named
   * as a non-reason because it is the one every flip gives. Digging in is named as the other
   * failure in the same breath, so the brief cannot be read as a licence to hold out.
   */
  it('asks for a per-peer change ledger with the evidence behind every change, and names the non-reasons', () => {
    const { parent, seats } = opened()
    const brief = debate.roundBriefFor(parent, seats, 1, 'address the write cost', 2)
    expect(brief).toContain('AGREE / DISAGREE / NOT REFUTED BUT UNCONVINCED')
    expect(brief).toContain('the specific new evidence that changed it')
    expect(brief).toContain('"Seat N argued it better"')
    expect(brief).toContain('are not evidence')
    expect(brief).toContain('Do not converge for the sake of converging')
    expect(brief).toContain('do not dig in for the sake of digging in')
    expect(brief).toContain('WHOLE position as the summary')
    expect(brief).toContain('`Confidence: …`')
    expect(brief).not.toMatch(/must disagree/i)
  })

  it('reminds a lensed seat of its lens, and says nothing of one to a seat without', () => {
    const { parent, seats } = opened({
      seats: [{ ...ROSTER[0]!, lens: 'the admission path' }, ROSTER[1]!]
    })
    expect(debate.roundBriefFor(parent, seats, 0, 'b', 2)).toContain('Your lens: the admission path')
    expect(debate.roundBriefFor(parent, seats, 1, 'b', 2)).not.toContain('Your lens')
  })

  it('starts from the question when the seat recorded no position last round', () => {
    const parent = organizer()
    expect(debate.openDebate(parent.id, HUMAN).ok).toBe(true)
    const seats = debate.seatsOf(parent.id)
    expect(debate.roundBriefFor(parent, seats, 0, 'b', 2)).toContain('no position recorded — this round starts from the question')
  })
})

/**
 * ⭐ **The evidence side of a flip is the half a deterministic check can see.** Whether a seat
 * changed its mind is not readable from prose; whether it cited anything new is. A report beside
 * the citation report, and like it ⛔ never a penalty.
 */
describe('the flip report', () => {
  let repo: string

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'agentyard-flip-'))
    mkdirSync(join(repo, 'src', 'daemon'), { recursive: true })
    writeFileSync(join(repo, 'src', 'daemon', 'tasks.ts'), '// real\n')
  })

  afterAll(() => {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      // Held handle on Windows.
    }
  })

  it('is nothing on round 1, where there is nothing to have flipped from', () => {
    expect(debate.flipReport(['I hold X, see src/daemon/tasks.ts'], repo)).toBeNull()
    expect(debate.flipLine(null)).toBeNull()
  })

  it('says when a round cites nothing an earlier round did not — a change here rests on words alone', () => {
    const report = debate.flipReport(
      ['I hold X, see src/daemon/tasks.ts', 'I now hold Y, and src/daemon/tasks.ts still applies'],
      repo
    )
    expect(report).toEqual({ newPaths: [], repeated: 1 })
    expect(debate.flipLine(report)).toMatch(/cites no path it had not cited in an earlier round \(1 repeated\)/)
    expect(debate.flipLine(report)).toContain('rests on words alone')

    const bare = debate.flipReport(['I hold X.', 'I now hold Y because seat 2 was persuasive.'], repo)
    expect(debate.flipLine(bare)).toContain('(and no path at all)')
  })

  it('lists what a round newly cites, marking what does not resolve, and counts nothing twice', () => {
    const report = debate.flipReport(
      ['I hold X, see src/daemon/tasks.ts', 'Y: src/daemon/tasks.ts, src/daemon/scheduler.ts and src/daemon/tasks.ts again'],
      repo
    )
    expect(report?.newPaths).toEqual([{ path: 'src/daemon/scheduler.ts', exists: false }])
    expect(report?.repeated).toBe(1)
    expect(debate.flipLine(report)).toBe(
      'newly cites 1 path(s) no earlier round cited: src/daemon/scheduler.ts (does not resolve)'
    )
  })

  it('compares against every earlier round, not only the last one', () => {
    const report = debate.flipReport(
      ['see src/daemon/tasks.ts', 'see nothing', 'see src/daemon/tasks.ts'],
      repo
    )
    expect(report?.newPaths).toEqual([])
  })
})

/**
 * ⚠️ Text, never a number: `0.85/0.8/0.75`, `~0.8`, `78%` and `high` are all things seats wrote in
 * t382, and turning any of them into a figure would be this tool believing something it cannot
 * establish.
 */
describe('the stated confidence', () => {
  it('prefers the `Confidence:` line the prompt asks for, as written', () => {
    expect(debate.statedConfidence('I hold X.\nConfidence: 0.78 that forced disagreement is wrong\nMore.')).toBe(
      '0.78 that forced disagreement is wrong'
    )
    expect(debate.statedConfidence('**Confidence**: high — both seats cite the same paths')).toBe(
      'high — both seats cite the same paths'
    )
  })

  it('falls back to the first sentence that mentions confidence, capped so it stays a label', () => {
    expect(debate.statedConfidence('Position. Confidence ~0.8 / 0.7 / 0.6; wrong if the link carries numbers.')).toBe(
      'Confidence ~0.8 / 0.7 / 0.6; wrong if the link carries numbers.'
    )
    expect(debate.statedConfidence('I am fairly confident (80%) in this.')).toBe('confident (80%) in this.')
    const long = debate.statedConfidence('Confidence: ' + 'x'.repeat(200))
    expect(long?.length).toBe(81)
    expect(long?.endsWith('…')).toBe(true)
  })

  it('is null when nothing was stated, so the label says so rather than inventing one', () => {
    expect(debate.statedConfidence('I hold X, see src/daemon/tasks.ts.')).toBeNull()
  })
})
