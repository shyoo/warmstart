import type { Attachment, DebateVerdict, Task } from '@shared/tasks.js'
import { isOpenConversation, policyVerifies } from '@shared/tasks.js'
import { resolveCompletionMode } from '@shared/policy.js'
import { describeAttachment } from './attachments.js'
import { adapter } from './adapters/index.js'
import { getProject, landingTargetFor } from './projects.js'
import { coldStartBlock } from './orientation.js'
import { markDelivered, messagesFor, runsFor } from './tasks.js'
import { childrenOf as splitChildrenOf } from './split.js'
import {
  agentPositionsFor,
  citationLine,
  citationReport,
  debatePhaseOf,
  flipLine,
  flipReport,
  lastPositionOf,
  seatsOf,
  statedConfidence
} from './debate.js'
import { resolveFinishPolicy } from './finish.js'
import { settings } from './settings.js'
import { lastCompactionLandedAt } from './compaction.js'

/**
 * A prompt and the images that go with it.
 *
 * ⚠️ The paths of these attachments are already written into `text`; the list is here because
 * the *bytes* travel by a route the sentence cannot express, and each adapter takes a different
 * one. See `AdapterCapabilities.imageInput`.
 */
export interface BuiltPrompt {
  text: string
  attachments: Attachment[]
}

/**
 * ⚠️ A named constant rather than a literal, because these prompts are assembled through a shell
 * heredoc as often as through an editor and a Windows path through one silently loses a backslash
 * (`AGENTS.md`, *Things that will bite*). One `'\n'` written once is one place for that to go wrong.
 */
const NL = '\n'

/**
 * What the agent is actually told, and what it is being handed along with it.
 *
 * The handoff from a previous run is prepended, because a successor that has to rediscover the state
 * of the branch pays for it twice - once in tokens and once in the mistakes it makes meanwhile.
 *
 * ⛔ Returns the attachments as well as the text, rather than only the text with the paths written
 * into it. The caller needs the list itself: a `spawn-flag` adapter puts the files in its argv, an
 * `inline` one puts the bytes in the envelope, and neither can be recovered from a sentence.
 */
/**
 * Which turn of a Plan & Split task this is.
 *
 * ⛔ Derived from whether the plan has pieces yet, not from a stored phase. A phase column would be a
 * second copy of a fact the edges already carry, and the two would disagree the first time a split
 * half-failed. ⚠️ `planning` is also the answer for a planner whose split was refused, which is
 * correct: it is being asked to plan again.
 */
export function planPhaseOf(task: Task): 'planning' | 'resolving' {
  return splitChildrenOf(task.id).length > 0 ? 'resolving' : 'planning'
}

/**
 * What the planner is told on its first turn.
 *
 * ⛔ **"Do not write code" is the load-bearing sentence.** An agent handed a repository and a
 * requirement will start building it, and a planner that builds the first piece itself has spent the
 * expensive context on the cheapest part of the job and left its own split with nothing to do.
 */
function planningInstruction(checkLead: string): string {
  void checkLead
  return [
    'You are PLANNING this work, not doing it.',
    '',
    'Read enough of the repository to be concrete — real file names, real functions, real ' +
      'constraints. Use `ask_human` for anything that changes what gets built; that is what this ' +
      'phase is for, and a question now is far cheaper than three subtasks built on a guess.',
    '',
    'When the requirement is settled, call `task_split` ONCE with the whole plan. Each piece must be ' +
      'completable by an agent that has NOT read this conversation, so its instruction has to carry ' +
      'its own context: what to change, where, and what "done" looks like. The dispatcher treats ' +
      'pieces without dependency edges as parallel work. If your plan says pieces must run or land ' +
      'sequentially, encode that ordering with `depends_on` even when the reason is integration or ' +
      'risk rather than a direct code dependency. Otherwise use `depends_on` only where one piece ' +
      'genuinely needs an earlier piece — an edge you did not need costs a subtask’s wait for nothing.',
    '',
    'The operator approves the whole split before anything is filed, so make each piece legible on a ' +
      'card. Do NOT write code, and do NOT start any of the pieces yourself. After the split ' +
      'returns, stop — you will be started again once every piece has settled.'
  ].join('\n')
}

/**
 * The sentence that closes the loop this project spent t226 falling into.
 *
 * ⛔ **An agent that stops without saying so is indistinguishable from one that is still working.**
 * An ordinary run stays open until `task_complete` arrives — that is the whole of its contract — so
 * a turn that ends any other way leaves the run open, the task reading `running`, the workspace held
 * and the worker slot reserved, for as long as the daemon lives. `await_human` is the tool that says
 * it; this is what makes the agent aware it has one, at the exact moment it would otherwise go quiet.
 *
 * ⭐ Measured on t226, 2026-09-05: the operator answered *"go with option C — I will close it out
 * myself"*, the agent obeyed and stopped, and the board showed the task running for the rest of the
 * evening because nothing it could call meant *"I have stopped"*.
 *
 * ⚠️ Deliberately appended to the sentence that asks for completion rather than offered beside it.
 * Named on its own it reads as an exit, and an agent handed an exit takes it.
 */
/**
 * How to ask, in the one wording every prompt uses.
 *
 * ⛔ **The choices go in `options`, and the sentence says so.** "Offer the options you are choosing
 * between" was all this used to say, and on t235 an agent obliged by writing `A) … B) … C)` into the
 * question *as well as* passing `options` — so when the tool call was mangled on the way out and the
 * options argument was lost, what reached the operator was a wall of prose with a text box under it,
 * answered by hand with the letter `B`. The argument is the part that becomes buttons; the question
 * is the part that becomes prose. Naming which is which costs a clause and is checked by the daemon
 * anyway (see `normaliseAsk`), because a prompt is guidance and the repair has to hold regardless.
 */
const ASK_HUMAN_CLAUSE =
  'If you need a decision from a person, call `ask_human` rather than guessing — pass each choice ' +
  'you are deciding between as an entry in its `options` argument, rather than lettering them out ' +
  'inside the question text, because that argument is what the operator answers in one click. It ' +
  'waits for a real answer.'

const HAND_BACK_CLAUSE =
  ' If the rest genuinely needs a person — a step only they can take, or work they have said they ' +
  'will close out themselves — call `await_human` with the reason instead of simply stopping. ' +
  'Ending your turn without calling one of these leaves the task reading as still running.'

/**
 * Check the branch against its landing target *before* saying the work is done.
 *
 * ⛔ **Completion is a claim about the branch, not about the working tree.** `task_complete` is the
 * one signal that an agent finished, and everything downstream reads it as *this branch is ready to
 * land*. An agent that ran the checks on a branch cut from an older trunk has proved something about
 * a tree nobody will ever merge: the target moved while it worked, and the first thing that finds out
 * is `readMergeability` inside `decideFinish`, long after the turn ended.
 *
 * ⭐ Measured on t363 (2026-09-11): the work was sound, `task_complete` arrived, and the conflict
 * surfaced afterwards from the tool — so the one agent holding the whole context of the change was
 * already gone by the time anything knew there was a merge to resolve. ⚠️ This does not close the
 * race, and is not claimed to: the target can move in the seconds between the check and the landing.
 * It removes the *stale* half — a divergence that was already on disk, unlooked-at, for the length of
 * the run — and leaves `decideFinish` as the backstop it always was.
 *
 * ⚠️ The re-run is the load-bearing half of the clause. A rebase changes the code the checks ran
 * against, so a green result from before it answers for a tree that no longer exists; an agent told
 * to rebase but not to re-check will rebase and report, which is the same claim with extra steps.
 *
 * ⚠️ Named in the same breath as the completion signal, and in that signal's own vocabulary — an
 * MCP-less agent has no `task_complete` and naming it would name a channel it has not got (see the
 * note in `promptFor`).
 */
function integrationClause(target: string, hasChecks: boolean, mcpLess: boolean): string {
  const declare = mcpLess ? 'write the `TASK COMPLETE: ` line' : 'call `task_complete`'
  return (
    `Immediately before you ${declare}, check whether this branch has fallen behind or diverged from ` +
    `\`${target}\` — fetch it first, because it can move while you work. If it has, rebase onto the ` +
    `latest \`${target}\` and resolve every conflict yourself, then re-run ` +
    (hasChecks ? "this project's checks" : 'the validation relevant to what you changed') +
    ' on the rebased branch: a result from before the rebase does not answer for the code after it. ' +
    `Do not ${declare} while a conflict is unresolved or a rebase is still in progress — that signal ` +
    'says the branch is ready to land, and a branch that does not rebase cleanly is not.'
  )
}

/**
 * What the planner is told when its pieces have all settled.
 *
 * ⛔ The table of outcomes is prepended by the caller, because "some of them failed" is the normal
 * case and the resolution turn exists precisely to deal with it. A planner woken with no idea what
 * happened would start by re-reading every child's thread at full price.
 */
function resolutionInstruction(
  task: Task,
  checkLead: string,
  commitHygiene: string,
  integration: string
): string {
  // ⛔ Named with their outcomes, because "some of them failed" is the normal case and a planner
  //    woken with no idea what happened would re-read every child's thread at full price to find out.
  const roll = splitChildrenOf(task.id)
    .map((child) => {
      const label = child.titleSummary ?? child.title.split(/\r?\n/)[0] ?? ''
      const why = child.status === 'completed' ? '' : ` — ${child.holdReason ?? 'no reason recorded'}`
      return `  t${child.seq} · ${child.status}${why}: ${label.slice(0, 160)}`
    })
    .join('\n')
  return [
    'Every piece of your plan has settled, and this branch already contains everything they merged ' +
      'into it. Some may have failed — that is why you are here rather than the task simply closing.',
    '',
    'How each piece turned out:',
    roll,
    '',
    'Review the result as a WHOLE: the pieces were built by agents that could not see each other’s ' +
      'work, so the seams between them are where the problems are. Small gaps you fix here. Large ' +
      'ones, or anything that changes what was agreed, ask about with `ask_human`.',
    '',
    'Work to the end without stopping between phases. ' +
      checkLead +
      'When the work is finished, call the MCP tool `task_complete` with a one-line summary. ' +
      commitHygiene +
      (integration ? ' ' + integration : '') +
      HAND_BACK_CLAUSE
  ].join('\n')
}

/**
 * What the organizer is told when every seat has answered.
 *
 * ⛔ **Arbitrating, not competing, and not casting a vote.** Published work is unambiguous on this
 * and it decides the whole shape: a diverse roster dramatically outperforms a homogeneous one under
 * a *judge* and gives **no** advantage under majority voting. An organizer that counts throws away
 * the only thing heterogeneity buys.
 *
 * ⛔ **Every position travels verbatim, labelled with the account and model that wrote it**, next to
 * the citation report. Summarising them here would put a fourth model's paraphrase between the
 * judge and the evidence.
 *
 * ⭐ **Three reports beside each name, and all three are reports rather than penalties**: the
 * citation check (paths that do not resolve), the flip report (from round 2, whether this round
 * cites anything an earlier round did not — the evidence side of a change of position, which is
 * the half of sycophancy a deterministic check can see), and the confidence the seat itself
 * stated, as it stated it. The organizer is told what each can and cannot establish. See
 * `flipReport` for the published work behind the second.
 *
 * ⚠️ The one tool call is named with its two shapes, and the round budget is stated as a fact rather
 * than as a request: the organizer may converge early and may never extend.
 */
function arbitrationInstruction(task: Task, projectRoot: string | null): string {
  const seats = seatsOf(task.id)
  const state = task.debate
  const round = state?.round ?? 1
  const rounds = state?.rounds ?? 1
  const positions = seats
    .map((seat, i) => {
      const who = [seat.ranOn ? `account ${seat.ranOn}` : null, seat.ranModel ?? null]
        .filter(Boolean)
        .join(', ')
      const position = lastPositionOf(seat) ?? `(no position — this seat ended ${seat.status}${seat.holdReason ? `: ${seat.holdReason}` : ''})`
      const cites = citationLine(citationReport(position, projectRoot))
      const flip = flipLine(flipReport(agentPositionsFor(seat.id), projectRoot))
      const confidence = statedConfidence(position)
      return [
        `--- Seat ${i + 1} · t${seat.seq}${who ? ` · ${who}` : ''} · stated confidence: ${confidence ?? 'none stated'}`,
        ...(cites ? [`⚠️ Citation check — ${cites}`] : []),
        ...(flip ? [`⚠️ Flip report — ${flip}`] : []),
        position
      ].join(NL)
    })
    .join(NL + NL)

  return [
    `You are the ORGANIZER of a debate. Round ${round} of at most ${rounds} has just finished, and ` +
      `${seats.length} agents have each answered this question independently:`,
    '',
    task.title,
    '',
    'Their positions, verbatim and unedited:',
    '',
    positions,
    '',
    '⚠️ The citation check and the flip report are reports, never penalties. A path that does not ' +
      'resolve is one of the few things about an argument this tool can establish rather than ' +
      'believe. The flip report says whether a seat cited anything this round that it had not ' +
      'cited before — a position that moved while citing nothing new moved on words alone, which ' +
      'is what sycophancy looks like from outside; a position that held while the evidence went ' +
      'against it is the other failure and the report cannot see it. The stated confidence is the ' +
      'seat’s own words, not a measurement. What to make of each is yours to judge.',
    '',
    'You are arbitrating, not competing, and you are not casting a vote. Weigh the arguments on ' +
      'their evidence, not on who made them or how confidently they were made. ⛔ Where the ' +
      'positions agree because nobody examined the question, say so — agreement is not evidence. ' +
      '⛔ Where a seat changed its position, look for the evidence it names for the change; a seat ' +
      'conceding is not evidence that it was wrong, and the dissent you report has to say what ' +
      'withdrew each dissent that was withdrawn.',
    '',
    'Then call the MCP tool `debate_round` ONCE, in one of its two shapes:',
    round < rounds
      ? '  • `{ continue: true, briefs: [...] }` — one brief per seat, each naming the SPECIFIC ' +
        'disagreement that seat has to address next. Use this while there is a real disagreement ' +
        'worth another round.'
      : `  • continuing is not available: this debate was authorised for ${rounds} round(s) and ` +
        'this was the last one. Converge.',
    '  • `{ converged: true, agreement, dissent, confidence, unresolved }` — the four parts, and ' +
      'a reply missing any of them is refused. ⛔ An empty dissent section is refused: if there ' +
      'genuinely was none, say that in the dissent field and say what was never contested.',
    '',
    `You may converge early — that only ever saves money and needs no permission. You may not ask ` +
      'for more rounds than the operator authorised; the tool will refuse and tell you why.',
    '',
    'Converging raises a card with five choices and BLOCKS until a person answers it. The answer ' +
      'comes back in the tool result and tells you what to do next. Do not guess it, and do not ' +
      'start any work before it arrives.'
  ].join(NL)
}

/**
 * What the organizer is told after the operator has answered the verdict card.
 *
 * ⛔ One paragraph per verdict, and only the one that was chosen — sent into the session that
 * already holds the whole debate, which is the saving this feature is built on.
 */
export function verdictInstruction(verdict: DebateVerdict, checkLead: string, commitHygiene: string): string {
  switch (verdict) {
    case 'execute':
      return (
        'The operator chose EXECUTE AS AGREED. The agreement you just reported is the spec — build ' +
        'it, here, in this session. Work to the end without stopping between phases. ' +
        checkLead +
        'When the work is finished, call `task_complete` with a one-line summary. ' +
        commitHygiene
      )
    case 'split':
      return (
        'The operator chose SPLIT THE WORK. Call `task_split` ONCE with the whole plan: two or more ' +
        'concrete pieces, each with a self-contained instruction an agent that has NOT read this ' +
        'debate could carry out. The pieces branch off this task’s branch and merge back into it. ' +
        'After it returns, STOP — you will be started again once every piece has settled.'
      )
    case 'discuss':
      return (
        'The operator chose ASK FOLLOW-UP QUESTIONS. This task is now a conversation: answer what ' +
        'they ask, one turn at a time, and stop after each. You keep this session and everything ' +
        'the debate put in it. Do not call `task_complete` on your own judgement.'
      )
    case 'complete':
      return (
        'The operator chose MARK COMPLETED. The agreement is the result; nothing more is to be ' +
        'built. Call `task_complete` with the agreement as the summary.'
      )
    case 'stop':
      return (
        'The operator chose STOP THE WORK. Stop here. Do not start anything, and do not commit. ' +
        'Every position, round and run is kept.'
      )
  }
}

/**
 * What a conversation is told at the end of every turn, instead of "finish the job".
 *
 * ⛔ **The whole of the difference between this kind and `work`, and it is mostly a subtraction.**
 * The ordinary closing instruction says run to the end, run the checks, commit, squash, report
 * complete — which is exactly right for a task dispatched at 3am and exactly wrong when a person is
 * reading each turn as it lands. Left in place it makes every reply in a conversation end with a
 * landing nobody asked for, and an agent that has been told to commit will commit half-finished work
 * rather than appear to have disobeyed.
 *
 * ⛔ **What is no longer subtracted is the commit itself.** This used to say *do not commit, merge
 * or push*, full stop, because a conversation's only route to a commit was the Commit button. A
 * commit on the agent's own branch costs nothing, risks nothing and is how work survives a
 * preemption — so it is now encouraged whenever it helps, and what stays forbidden is the part that
 * touches somebody else's branch: merging or pushing to the landing target by hand.
 *
 * ⛔ **Landing is a tool call, and only when the person asks.** `land_work` rebases, runs the
 * project's checks and merges or pushes under the project's policy, and the conversation carries on
 * afterwards on the branch it names. Naming it here is what stops the two failure modes at either
 * end: an agent that lands whenever it feels finished, and an agent that has committed everything a
 * person asked for and has no idea how to get it onto `main`.
 *
 * ⛔ **`task_complete` is still named, and is still the only completion signal.** What changes is
 * who decides to send it: the agent is told not to reach for it on its own judgement, because the
 * person it is talking to has a Finish button and that button is the judgement. Leaving the tool
 * unmentioned would be worse than either — see the note in `promptFor` about naming tools an agent
 * has not got, which has the same failure mode in reverse.
 *
 * ⚠️ **Two versions, decided from `capabilities.mcp` and never from an adapter name.** An MCP-less
 * agent has no `land_work` and no `task_complete`; its terminal contract is a line of text, and its
 * route to a landing is a person pressing **Land** after it says the commit is ready. Naming the
 * wrong one would be naming a channel the agent has not got.
 */
function conversationInstruction(mcpLess: boolean): string {
  return (
    'This is an ongoing conversation, not a one-shot task. Answer what has just been asked and ' +
    'stop there — you will get another turn, so there is no need to finish everything now and no ' +
    'need to leave the work in a shippable state at the end of every turn. ' +
    'You may commit on your own branch whenever it helps — a commit is how work survives between ' +
    'turns — but never merge or push to the landing target yourself. ' +
    (mcpLess
      ? 'Commit when you are asked to, and say in your reply that the work is ready; the person ' +
        'lands it from this thread. ' +
        'Do not end a reply with a line beginning `TASK COMPLETE: ` on your own judgement — that ' +
        'line reports the whole task finished, so write it only if you are told the work is done. ' +
        'If you need a decision from a person, end your reply with a line beginning `NEEDS DECISION:` ' +
        'followed by the question, and stop rather than guessing. If you are choosing between ' +
        'specific options, put each one on its own line directly under it as ' +
        '`- <the option> — <what choosing it means>`, so they can be offered as buttons.'
      : 'When the person asks you to land the work, commit it and then call the MCP tool ' +
        '`land_work`: it rebases, runs this project’s checks and merges or pushes per policy, and ' +
        'tells you the new branch to carry on in. Landing does not end this task. ' +
        'Do not call `task_complete` on your own judgement — call it only if you are told the work ' +
        'is done. ' +
        ASK_HUMAN_CLAUSE)
  )
}

/**
 * Has this conversation been compacted since it was last given this task's prompt and contract?
 *
 * ⛔ **The undo for `resumed`, and the reason the subtraction is safe to make at all.** A compaction
 * replaces the turns an agent was holding with a summary somebody else wrote, and nothing guarantees
 * that summary kept the sentence naming `task_complete`. Both compaction paths land in the same
 * table — the one this tool buys before prompting a revived conversation (`compactOnResume`) and the
 * one the CLI performs on itself when a context fills — so one reading answers for both.
 *
 * ⛔ **Measured against the start of this task's last run in this session**, which is the moment the
 * framing was last sent. Any earlier reference point would answer `true` forever once a conversation
 * had ever compacted; any later one would miss the compaction that happened during the run being
 * continued. ⚠️ Called before `startRun`, so the newest run on this session is the previous one.
 *
 * ⚠️ `false` for a session that has never compacted and for a task that has never run in it — the
 * second is a borrowed conversation, where `resumed` is already false and nothing is withheld.
 */
export function framingLapsed(taskId: string, sessionId: string): boolean {
  const landed = lastCompactionLandedAt(sessionId)
  if (landed === null) return false
  const prior = runsFor(taskId).find((r) => r.sessionId === sessionId)
  return prior ? landed >= prior.startedAt : false
}

/**
 * What replaces the closing contract on a turn into the session that already has it.
 *
 * ⛔ **One sentence rather than nothing, and the difference is the completion signal.** Everything
 * else the contract carries — the checks, commit hygiene, `ask_human`, the hand-back — is guidance
 * the agent is already following, and re-teaching it costs ~200 tokens a turn for an agent that has
 * been reading it since its first. `task_complete` is not guidance: it is the *only* thing that says
 * an agent finished, a clean exit says nothing, and a run that has lost it ends in `awaiting_human`
 * however well the work went. So the naming survives the subtraction and the rest does not.
 *
 * ⚠️ It points at the instructions rather than restating them, which is what keeps it one sentence.
 * The session has them; what it needs is to be told they still apply, because a turn that arrives
 * with a new note and no contract at all is ambiguous about whether the old one was withdrawn.
 *
 * ⚠️ **`integrationClause` is pointed at, not repeated**, and the clause it names is the one whose
 * answer went stale while the session waited: a follow-up arriving hours later is the turn most
 * likely to be sitting behind its target. It is still only *pointed* at, for the reason above — the
 * session read it in full on its first turn — so what this adds is the phrase that keeps *the state
 * this branch has to be in* inside the thing the agent is being told still applies.
 *
 * ⚠️ Two endings, for the same reason `conversationInstruction` has two: an MCP-less agent's terminal
 * contract is a line of text and naming it a tool call would name a channel it has not got.
 */
function resumedAnchor(mcpLess: boolean): string {
  return (
    'Your instructions from the start of this task still apply — including this project’s checks, ' +
    'the state this branch has to be in before you report complete, and how its work is to be ' +
    'finished. ' +
    (mcpLess
      ? 'When the work is finished, end with a line beginning `TASK COMPLETE: ` followed by a ' +
        'one-line summary.'
      : 'When the work is finished, call the MCP tool `task_complete` with a one-line summary.')
  )
}

export function promptFor(
  task: Task,
  adapterId: string,
  resumed = false,
  opts: {
    markDelivered?: boolean
    branchNotice?: string | null
    /**
     * The conversation being resumed has been **compacted** since it was last given this task's
     * prompt and contract — or is about to be, before this prompt goes in.
     *
     * ⛔ It is `resumed`'s undo. Everything the flag below suppresses is suppressed on the grounds
     * that the session is still holding it, and a compaction is precisely the event that makes that
     * false: what the agent holds afterwards is a summary somebody else wrote, and neither the task's
     * own instruction nor the sentence naming `task_complete` is guaranteed to have survived it. A
     * run that lost the completion signal ends in `awaiting_human` however well the work went, so
     * this is the direction it is safe to be wrong in.
     *
     * ⚠️ Set by the two call sites that resume, from `compactOnResume`'s own plan and from the
     * `compactions` table. Absent means *no compaction has happened*, which is the state of every
     * cold prompt and the only honest default for a caller that has not looked.
     */
    compacted?: boolean
  } = { markDelivered: true }
): BuiltPrompt {
  const parts: string[] = []
  const attachments: Attachment[] = []
  if (opts.branchNotice) {
    parts.push(opts.branchNotice)
  }
  if (task.handoffNote) {
    parts.push(
      ['Continuing earlier work. Handoff from the previous session:', task.handoffNote, ''].join('\n')
    )
  }

  // ⛔ **Two questions, not one, and they have different answers.** `holdsPrompt` asks whether this
  // conversation already contains what the task was asked to do; `holdsContract` asks whether it is
  // already running under the contract this turn wants. They came apart the moment Commit was added
  // to a conversation: that session holds every word of the chat *and* has just had the contract it
  // was working under withdrawn, so the prompt is redundant there and the closing instruction is not.
  //
  // ⚠️ A compaction answers `false` to both, which is what makes it safe to withhold anything at all.
  const holdsPrompt = resumed && !opts.compacted
  // ⛔ A conversation carrying a real rung is not an open conversation any more, and the contract it
  // is holding is the wrong one. ⚠️ **Neither button writes a rung now** — Commit asks, Land lands,
  // and both leave `finish_policy` on `inherit` so the thread stays open — so the only thing that
  // reaches this today is an operator setting the task's own **finish** dropdown, which is them
  // saying the conversation is to be finished like a work task. `isOpenConversation` is still the
  // one flag that says which contract a turn runs under, so a task that has left it is told the new
  // contract in full rather than being left under the one it was given.
  const contractWithdrawn = task.kind === 'conversation' && !isOpenConversation(task)
  const holdsContract = holdsPrompt && !contractWithdrawn

  const project = task.projectId ? getProject(task.projectId) : null
  // ⛔ **Where this project keeps its orientation, said once per conversation and never again.** An
  // agent opening on an empty state guesses at what to read, and the guess is expensive: it greps,
  // it opens the wrong three files, and on a repository that keeps `AGENTS.md` it does all of that
  // beside the page that would have answered it. ⚠️ `!holdsPrompt` is the same gate the task's own
  // instruction uses, which is the whole point — a session already carrying this task's context has
  // already read this, and orientation is worth exactly one telling. See `orientation.ts`.
  if (!holdsPrompt) {
    const cold = coldStartBlock(project)
    if (cold) parts.push(cold)
  }

  // ⚠️ The first prompt-bearing message is the task's own prompt and is restated: a fresh session after a
  // preemption has no idea what it was asked to do. Everything after it is a *note*, and a note
  // typed into a live session was already answered there - repeating it would charge for it twice and
  // leave the agent unsure what is still outstanding.
  //
  // ⛔ Except into a resumed conversation, which is the one case where the reason above does not
  // hold: that session has the original prompt in its own history and everything it did about it.
  // Restating it there reads as being asked to do the work a second time, which is the failure the
  // delivery bookkeeping exists to prevent - it would just be arriving through the one message the
  // bookkeeping deliberately exempts.
  const thread = messagesFor(task.id).filter(
    (m, i) => m.role === 'human' || m.role === 'controller' || (m.role === 'agent' && i === 0)
  )
  const outstanding = thread.filter((m, i) => (i === 0 && !holdsPrompt) || m.deliveredAt === null)
  // ⛔ **A follow-up typed into a conversation that is still live is sent as it was typed, and
  // nothing else.** Measured on t260: a person asked a question, the agent answered, they asked the
  // next thing — and what reached the session was their opening prompt again on top, their new
  // sentence in the middle, and the whole conversation contract underneath, every turn. All three
  // pieces exist for a session that does *not* already have them; this one does, in its own history,
  // because it is the same session that read them the first time. Restating the opening prompt reads
  // as being asked to do that work again, and re-appending the contract spends tokens re-teaching an
  // agent something it is already following.
  //
  // ⛔ **And an ordinary task is the same session and the same problem**, which this missed until
  // t286. `work` is by far the commonest kind and every warm continuation of one — a note typed into
  // a running task, a reply that restarts a rested one — arrived with the title on top and the whole
  // closing contract underneath, into a session that had been reading both since its first turn. What
  // changed here is only *which kinds* the subtraction applies to; the reason was never conversation-
  // specific. What an ordinary task gets in its place is one sentence, `RESUMED_ANCHOR` — see there
  // for why it is not nothing.
  //
  // ⚠️ Narrow on purpose: `resumed` is false for a fresh session after a preemption and false for a
  // borrowed one, and both of those genuinely need the prompt and the contract — see the notes on
  // those two call sites. This is the same-session case alone.
  const followUp = holdsContract && outstanding.length > 0
  if (thread.length === 0 && !holdsPrompt) {
    parts.push(task.title)
  } else {
    let opened = false
    for (const message of outstanding) {
      if (!holdsPrompt && !opened && message.text !== task.title) {
        parts.push(task.title)
      }
      opened = true
      parts.push(message.text)
    }
  }
  // ⛔ **The attachments that travel are the attachments of the messages that travel**, and this is
  // the only rule that is right in every case. Anything else either replays a screenshot on every
  // run of a long task — paying for it each time — or drops it on the fresh session a preemption
  // starts, where the agent is being handed the original prompt and needs the picture that came
  // with it. The delivery bookkeeping already decides this; the images just follow it.
  for (const message of outstanding) attachments.push(...message.attachments)
  if (opts.markDelivered && outstanding.length > 0) {
    markDelivered(outstanding.map((m) => m.id))
  }

  // ⛔ **The absolute path goes in the text on every adapter, including the ones that also get the
  // bytes.** It costs ~20 tokens, all three CLIs read a PNG off disk with their own view tool
  // (measured 2026-08-31, agy included), and it is what rescues a run whose inline block a vendor
  // update quietly stopped accepting. On antigravity, which cannot be sent bytes at all, it is not
  // a fallback — it is the whole channel.
  if (attachments.length > 0) {
    parts.push(
      (attachments.length === 1 ? 'Attached context: ' : 'Attached context: ') +
        attachments.map(describeAttachment).join('; ') +
        '. Open the file if you need to see it.'
    )
  }

  // ⛔ Only name tools this adapter actually gets. `mcp: false` means the daemon spawns it with no
  // MCP server at all - true for Antigravity, whose `agy mcp add` registers globally and so cannot
  // carry the per-session identity the tools need, and true for every declarative adapter.
  //
  // ⚠️ Telling an agent to call a tool it does not have is not a harmless surplus sentence. It is
  // the last instruction in the prompt, so it is what the agent tries to do when it believes it has
  // finished: it hunts for `task_complete`, cannot find it, and burns turns deciding what to do
  // instead - the same trap as `claude -p /usage`, from the other side. And it can never succeed,
  // because `task_complete` is the *only* signal that an agent finished, so every run on such an
  // adapter ends in `awaiting_human` no matter how well the work went.
  //
  // ⚠️ `awaiting_human` remains the honest answer here, and this does not change that: without the
  // tool there is genuinely no signal, and inventing one from a clean exit would be the guess this
  // project refuses to make. What changes is that the operator is told *why* the hand-off is
  // structural rather than being left to read it as the agent having failed.
  const { policy } = resolveFinishPolicy(task, project)
  const checks = policyVerifies(policy) ? (project?.config?.check ?? []) : []
  // Keep a task branch reviewable and cheap to rebase. This is conditional: a branch can legitimately
  // carry separate commits when it contains independently useful work, and the agent must never
  // rewrite anything that is already on the landing target.
  const commitHygiene =
    'When committing, if two or more commits ahead of this task branch’s landing target all belong ' +
    'to this task, squash them into one coherent commit where safe. Do not rewrite commits already ' +
    'on the landing target, force-push, or use a destructive reset.'

  // ⛔ **Only where there is a branch and a target to be behind**, which is `vcs: 'git'` and nothing
  // else. A non-git project is a pool of one over its own directory (`policyFor`), so there is no
  // rebase to ask for and the clause would be an instruction the agent cannot carry out — the same
  // failure as naming a tool it has not got, one paragraph up. ⚠️ Not gated on the finish policy:
  // `commit-only` and `await-human` leave the branch where the agent put it, and a branch a person
  // will land by hand later is exactly the one that must not be handed over mid-conflict.
  //
  // ⚠️ **Who re-runs the checks is not the same question on a one-turn CLI.** A
  // `streamPrompts: 'once'` adapter is told, further down, that the tool runs this project's checks
  // outside its sandbox after it commits — so naming them again here would contradict that in the
  // one turn it has. It is still asked to rebase and to re-validate; what changes is that the clause
  // points at *the validation relevant to what you changed* rather than at a list somebody else runs.
  const toolRunsChecks = adapter(adapterId).info.capabilities.streamPrompts === 'once'
  const integration =
    project?.vcs === 'git'
      ? integrationClause(
          landingTargetFor(task, project),
          checks.length > 0 && !toolRunsChecks,
          !adapter(adapterId).info.capabilities.mcp
        )
      : ''

  // ⛔ **A plan task's closing instruction is a different instruction**, and it is selected on
  // `task.kind` — which is a domain fact, not a mode name. (The rule this codebase enforces against
  // branching on a name is about adapters and objectives, which are *data*; what kind of thing a task
  // is is not.) Phase 1 delegates and stops; phase 2 reviews what came back and finishes.
  const planPhase = task.kind === 'plan' ? planPhaseOf(task) : null
  // ⛔ Same rule, same reason: what kind of thing a task is is a domain fact, not a mode name. The
  // organizer arbitrates on `arbitrating` and does the work the operator chose on `executing`.
  const debatePhase = debatePhaseOf(task)

  if (adapter(adapterId).info.capabilities.mcp) {
    // ⚠️ This belongs only in the first prompt. `task_read` is a recovery route for recorded context,
    // not an instruction to spend tokens re-reading a thread the live session already holds.
    if (!holdsPrompt) {
      parts.push(
        'Warmstart gives you the MCP tool `task_read` to read this task’s recorded thread and prior ' +
        'runs. Use it when an earlier task reference or result matters; it is scoped to this task.'
      )
    }
    // ⛔ The completion mode changes what "finished" means, so it belongs in the same sentence
    // as `task_complete` rather than somewhere earlier in the prompt. ⚠️ `ask_human` is offered
    // in **both** modes: stopping for a decision that changes what you build is never the thing being
    // discouraged, and an autonomous agent that guessed instead would be the failure this all exists
    // to prevent.
    const checkpointed =
      resolveCompletionMode(
        task,
        task.projectId ? getProject(task.projectId) : null,
        settings().completionMode
      ).mode === 'checkpointed'
    const checkLead =
      checks.length > 0
        ? `Before reporting complete, run this project's checks (${checks.map((c) => `\`${c}\``).join(', ')}) and ensure they pass. `
        : ''
    if (isOpenConversation(task)) {
      // ⚠️ Withheld only on a follow-up into the session that was already told it — see `followUp`.
      if (!followUp) parts.push(conversationInstruction(false))
    } else if (planPhase === 'planning') {
      parts.push(planningInstruction(checkLead))
    } else if (planPhase === 'resolving') {
      parts.push(resolutionInstruction(task, checkLead, commitHygiene, integration))
    } else if (debatePhase === 'arbitrating') {
      parts.push(arbitrationInstruction(task, project?.root ?? null))
    } else if (debatePhase === 'executing' && task.debate?.verdict) {
      parts.push(verdictInstruction(task.debate.verdict, checkLead, commitHygiene))
    } else if (followUp) {
      // ⚠️ One sentence where the whole contract used to be. See `RESUMED_ANCHOR`.
      parts.push(resumedAnchor(false))
    } else
    parts.push(
      (checkpointed
        ? 'Work in phases. At each phase boundary call the MCP tool `checkpoint` with what you have ' +
          'done and what you propose to do next, and wait for the answer before starting the next ' +
          'phase. When every phase is done, ' +
          (checkLead ? checkLead.toLowerCase() : '') +
          'call `task_complete` with a one-line summary. '
        : 'Work to the end without stopping between phases. ' +
          checkLead +
          'When the work is finished, call the MCP tool `task_complete` with a one-line summary. ') +
        commitHygiene + (integration ? ' ' + integration : '') + ' ' + ASK_HUMAN_CLAUSE +
        HAND_BACK_CLAUSE
    )
  } else {
    // ⛔ The options are asked for in the same breath as the question, because the operator's side
    // of this is a card with buttons on it. A question whose choices are written into the sentence -
    // *"(Option A) ... (Option B)"*, which is what antigravity did on t63 - arrives answerable only
    // in prose, and nothing here will guess the choices back out of it.
    const checkLead =
      checks.length > 0
        ? `Before finishing, run this project's checks (${checks.map((c) => `\`${c}\``).join(', ')}) and ensure they pass cleanly. `
        : ''
    // ⛔ The same subtraction as above, in the vocabulary this adapter was given. An MCP-less agent's
    // terminal contract is a line of text rather than a tool call, so a conversation has to be told
    // not to write that line rather than not to call that tool — but it still has to be told what
    // the line *is*, because being asked to finish is a thing that can happen to it later.
    // ⚠️ `followUp` withholds even the conversation wording, for the reason given where it is
    // computed: the session it is going to has already been told it and has not stopped since. An
    // ordinary task gets the one-sentence anchor in its place, in this adapter's vocabulary — the
    // line, not the tool call, because naming the wrong channel is the failure the note above
    // describes.
    if (followUp) {
      if (!isOpenConversation(task)) parts.push(resumedAnchor(true))
    } else {
      parts.push(
      isOpenConversation(task)
        ? conversationInstruction(true)
        : checkLead +
        'When the work is finished, commit what you have and end with a line beginning `TASK COMPLETE: ` ' +
        'followed by a one-line summary of what changed. ' + commitHygiene +
        (integration ? ' ' + integration : '') +
        ' If you need a decision from a person, end your reply with a line beginning ' +
        '`NEEDS DECISION:` followed by the question, and stop rather than guessing. If you are ' +
        'choosing between specific options, put each one on its own line directly under it as ' +
        '`- <the option> — <what choosing it means>`, so they can be offered as buttons. ' +
        'If multiple options can be chosen (checkboxes), indicate that with `NEEDS DECISION: [multi] <question>` ' +
        'or include `(multi-select)` / `(select all that apply)` in the question.'
      )
    }
  }

  // ⛔ **A conversation stops here, and skipping the block below is the point rather than an
  // omission.** What follows tells a `streamPrompts: 'once'` CLI that it gets one turn and must
  // commit everything in it — the exact instruction a conversation exists to withhold. The reason
  // that block exists still holds for such an adapter (its process really does end with the turn),
  // but the consequence does not: a conversation's next turn arrives on a *revived* session, its
  // workspace is retained across the wait, and the commit is the operator's to ask for.
  if (isOpenConversation(task)) {
    return { text: parts.join('\n\n'), attachments }
  }

  // ⛔ A `streamPrompts: 'once'` CLI gets its landing instruction **here or never**. The
  // `ask-agent` finish - *tell the still-live agent to commit* - requires a live session, and such a
  // process exits the instant its one turn ends. That is structural, not unlucky: measured on t56,
  // 2026-08-30, where the instruction was composed, could not be sent, and the task rested with two
  // uncommitted files it had been told to commit only in the vaguest terms.
  //
  // ⚠️ Deliberately narrow. A `conversation` adapter may still be reachable afterwards, and
  // whether Antigravity's print-mode process outlives its turn has **not been measured** - so it
  // keeps the existing behaviour rather than being guessed at.
  if (adapter(adapterId).info.capabilities.streamPrompts === 'once') {
    const project = task.projectId ? getProject(task.projectId) : null
    // ⛔ Through `resolveFinishPolicy`, never by reading `landing.finishInstruction` directly.
    // That field is defined as *what a `custom` finish tells the agent*, and the resolver is the
    // one place that gate lives - it returns an instruction only when the resolved policy really
    // is `custom`. Read raw, it fired under every policy: measured on t56, 2026-08-30, where a
    // project on `commit-and-merge` sent codex *"Run /commit and follow every one of its six
    // steps. Do not push."* - a Claude Code skill codex has not got, whose sixth step **is** the
    // push the same sentence forbids. Two contradictions and a dead command, in the one turn the
    // agent had.
    const { policy, instruction } = resolveFinishPolicy(task, project)
    // ⛔ The plain fallback says what the *resolved policy* actually wants, rather than "commit"
    // and nothing else. Silence about pushing is not neutral: the agent has to guess, and t56's
    // operator had written "Do not push" by hand precisely because the prompt would not say it.
    // Only the two policies that want a remote ask for one.
    const pushes = policy === 'commit-and-push' || policy === 'pull-request'
    const plain =
      'Commit everything you change' +
      (task.branch ? ` on \`${task.branch}\`` : '') +
      ' before your turn ends. ' +
      commitHygiene + ' ' +
      (pushes
        ? 'Then push it — nothing will do that for you afterwards.'
        : 'Do not push; the tool takes it from there. Nothing will ask you again.')
    parts.push(
      'You get one turn and no follow-up, so finish the job in it. ' + (instruction ?? plain)
    )

    // ⛔ Say who runs the checks, because the agent cannot find out and guessing costs it the turn.
    // `runChecks` executes this list in the **daemon**, outside whatever sandbox the worker is in.
    // Measured on t56, 2026-08-30: codex ran `npm test` itself under `--sandbox workspace-write`,
    // was denied the WMI query one test needed, could not tell a denied query from a regression it
    // had caused, and stopped to ask about a suite that passes unsandboxed on the same machine.
    //
    // ⚠️ Only when the policy actually verifies *and* commands are declared. On any other rung, or
    // an empty list, nothing runs them afterwards and telling the agent otherwise would be a lie
    // that talks it out of the only checking anybody does.
    const checks = policyVerifies(policy) ? (project?.config?.check ?? []) : []
    if (checks.length > 0) {
      parts.push(
        'You do not have to run this project’s checks yourself: after you commit, the tool runs ' +
          `${checks.map((c) => `\`${c}\``).join(', ')} outside your sandbox and reports the ` +
          'result. Run what you need to be confident in the change, but a command that fails ' +
          'because your environment forbids it is not a reason to stop — say so and commit.'
      )
    }
  }
  return { text: parts.join('\n\n'), attachments }
}
