import { z, type ZodRawShape } from 'zod'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RpcMethod, RpcParams, RpcResult } from '@shared/protocol.js'
import { conversationLandingResultText, parseOptionList } from '@shared/tasks.js'
import { normaliseAsk } from '@shared/policy.js'
import { failed, text } from './payload.js'

/**
 * The worker tier's tools, defined once for both of the channels an agent can reach them by.
 *
 * ⛔ **One table, two transports.** An agent whose CLI speaks MCP reaches these through
 * `index.ts`; an agent whose CLI does not, but can run a shell command, reaches the very same
 * definitions through `src/agentcli` — the `warmstart-agent` helper. The descriptions are the only
 * documentation an agent ever reads, and the RPC each one makes is the contract with the daemon, so
 * a second copy for the helper would be a second contract that drifts the first time a tool changes.
 *
 * ⚠️ Nothing here reads the environment, opens a socket or touches stdio. Who the caller is and how
 * a call reaches orchestratord are the `io` the transport supplies: the MCP server sends its
 * session id and the daemon's own token; the helper sends a per-session agent token, and the daemon
 * overwrites `sessionId` with the session that token was minted for.
 */

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>

export interface ToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface WorkerToolIo {
  /** Who is calling. Empty from the helper, whose session the daemon reads off its token. */
  sessionId: string
  rpc<M extends RpcMethod>(method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
  /** `rpc` for a call that may wait on a person or on the project's checks. */
  held<M extends RpcMethod>(extra: ToolExtra | undefined, method: M, params?: RpcParams<M>): Promise<RpcResult<M>>
}

export interface WorkerToolConfig {
  title: string
  description: string
  inputSchema: ZodRawShape
}

export interface WorkerTool {
  name: string
  config: WorkerToolConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- erased per tool; `def` types each one
  handler: (args: any, extra?: ToolExtra) => Promise<ToolResult>
}

/**
 * Scoped to its own run, its own project, its own mandate and its own budget. ⛔ Deliberately absent:
 * raw process spawn, raw SQL, the filesystem outside its project, any way to widen its own mandate,
 * and any way to assign work directly to another worker.
 */
export function workerTools(io: WorkerToolIo): WorkerTool[] {
  const tools: WorkerTool[] = []
  function def<S extends ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>, extra?: ToolExtra) => Promise<ToolResult>
  ): void {
    tools.push({ name, config, handler: handler as WorkerTool['handler'] })
  }

  /**
   * The worker can recover the task record it is actually running without reading the database, and
   * can name one sibling in the same project — but gains no route into the rest of the board. This
   * is particularly useful after a resumed session when a past task reference matters more than the
   * opening instruction.
   */
  def(
    'task_read',
    {
      title: 'Read a task and its recorded history',
      description:
        'Read the task you are currently working on, including its whole thread and every prior run. ' +
        'Use this when an earlier reference or result matters. Pass `task` (a t-number like `t12`, ' +
        'or an id) to read another task in the same project instead — a task on another project, ' +
        'or a reference that names nothing, is refused.',
      inputSchema: {
        task: z
          .string()
          .optional()
          .describe(
            'Another task in the same project to read, as a t-number (t12) or an id. Omit to read this task.'
          )
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.taskRead', {
          sessionId,
          ...(args.task ? { task: args.task } : {})
        })
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: 'No active task is associated with this session.' }],
            isError: true
          }
        }
        return text(result)
      } catch (err) {
        return failed(err)
      }
    }
  )

  /**
   * How this task's project lands work (t906). t905's agent asked the operator to confirm a finish
   * policy it had no way to see; this is that answer, resolved the way the landing will resolve it.
   * ⛔ Read-only: an agent recommends a change, a person makes it.
   */
  def(
    'project_settings',
    {
      title: 'Read how this project lands work',
      description:
        "Read this task's project settings: the finish policy and what Warmstart will do with your " +
        'work after you report (rebase, checks, merge, push or pull request), the landing target, which ' +
        'remote is home and which is upstream, the checks, the workspace mode and your mandate. Call it ' +
        'before landing, pushing or opening a pull request by hand, or when you are unsure how the work ' +
        'will be finished — rather than asking the operator. Read-only: if a setting looks wrong for ' +
        'this work, recommend the change to the operator; `howToChange` says where they make it.',
      inputSchema: {}
    },
    async () => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.projectSettings', { sessionId })
        if (!result) {
          return {
            content: [{ type: 'text' as const, text: 'This session is not working on a task in a project.' }],
            isError: true
          }
        }
        return text(result)
      } catch (err) {
        return failed(err)
      }
    }
  )

  /**
   * The worker tier's way to ask a person something, rather than guessing and being wrong expensively.
   *
   * ⛔ **This replaced `request_human`, which could not carry an answer.** That tool routed through
   * the approval path, whose answer set is closed at allow/deny — so an agent that asked *"OAuth,
   * session cookies, or magic link?"* got back `The operator agreed.` The question travelled all the
   * way to a person and the reply had nowhere to sit. See daemon/questions.ts.
   *
   * ⚠️ This call blocks, and it can block for minutes: the daemon holds it until somebody answers or
   * until the session's prompt cache expires. That is deliberate — an answer that arrives while the
   * session is still warm costs a cache read, and the same answer after a restart costs a full rebuild.
   */
  def(
    'ask_human',
    {
      title: 'Ask the operator a question and wait for the answer',
      description:
        'Put a question to the operator and wait for a real answer. Use this instead of guessing ' +
        'whenever the answer changes what you build. Offer options when there is a fixed set of ' +
        'sensible ones — the operator answers those in one click. Put each one in `options`, one per ' +
        'entry, rather than lettering them out inside `question`: only `options` becomes buttons, and ' +
        'a question that also lists them in its prose is answered twice over. Set `multi_select` to true ' +
        '(or `multiSelect`) if the operator can choose more than one option (checkboxes). ' +
        'Leave options empty for an open question. If nobody answers in time you are told so plainly; stop rather than guessing.',
      inputSchema: {
        question: z
          .string()
          .describe(
            'The question, in full. The operator sees exactly this text. State the decision and the ' +
              'context for it; leave the choices themselves to `options`.'
          ),
        header: z.string().optional().describe('A few words naming the decision, e.g. "Auth approach"'),
        // ⛔ A bare string is accepted as well as an array, and that is not laziness. A schema that
        // *rejects* `options: "[\"A\", \"B\"]"` does not get a better-formed retry — it gets the call
        // failing, and the model asking again with the choices flattened into the question text, which
        // is how a three-way decision reaches the operator as a text box (t235).
        options: z
          .union([
            z.array(
              z.union([
                z.string(),
                z.object({
                  label: z.string().describe('The choice, as the operator will see it on a button'),
                  detail: z.string().optional().describe('What choosing this means, and what it costs')
                })
              ])
            ),
            z.string()
          ])
          .optional()
          .describe('Leave empty for an open question'),
        multi_select: z
          .boolean()
          .optional()
          .describe('May the operator choose more than one option (checkboxes)? Set true for multiple selection.'),
        multiSelect: z.boolean().optional().describe('Alias for multi_select'),
        is_multi_select: z.boolean().optional().describe('Alias for multi_select'),
        multiple: z.boolean().optional().describe('Alias for multi_select')
      }
    },
    async (args, extra) => {
      const sessionId = io.sessionId
      const rawOptions = typeof args.options === 'string' ? parseOptionList(args.options) : (args.options ?? [])
      const explicitMulti =
        args.multi_select === true ||
        args.multiSelect === true ||
        args.is_multi_select === true ||
        args.multiple === true

      // ⛔ One repair, shared with the daemon and with the native-tool path: whatever the CLI
      // serialised into the question text is pulled back out, and the kind is decided from what the
      // question *has* rather than from which arguments survived the trip. See `normaliseAsk`.
      const asked = normaliseAsk({
        question: args.question,
        header: args.header ?? null,
        kind: explicitMulti ? 'multi' : rawOptions.length > 0 ? 'choice' : 'text',
        options: rawOptions.map((option, index) =>
          typeof option === 'string'
            ? { id: `opt${index + 1}`, label: option }
            : {
                id: `opt${index + 1}`,
                label: option.label,
                ...(option.detail ? { detail: option.detail } : {})
              }
        )
      })
      try {
        const resolution = await io.held(extra, 'question.ask', {
          sessionId,
          origin: 'ask_human',
          kind: asked.kind,
          question: asked.question,
          ...(asked.header ? { header: asked.header } : {}),
          ...(asked.options.length > 0 ? { options: asked.options } : {})
        })
        return { content: [{ type: 'text' as const, text: resolution.reply }] }
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Could not reach the operator: ${String(err)}` }
          ],
          isError: true
        }
      }
    }
  )

  /**
   * A phase boundary on a `checkpointed` task.
   *
   * ⛔ A Question with a fixed answer set, which is the one place a question's options are *not*
   * written by the asker - because the three things a person can say at a phase boundary are the same
   * three every time: carry on, do something else, or stop. That makes it answerable in one click on
   * the Attention bar, which matters more here than anywhere else: a checkpoint is answered often, and
   * an interaction that costs a page load each time would train the operator to turn checkpointing off.
   *
   * ⚠️ Named in the prompt only for tasks whose completion mode resolves to `checkpointed`. An
   * autonomous agent is told to work to the end, and calling this would be a stop nobody asked for.
   */
  def(
    'checkpoint',
    {
      title: 'Report a finished phase and wait for the go-ahead',
      description:
        'Call this at a phase boundary when the task is being run in phases. Say what you have done ' +
        'and what you propose to do next, then wait. The operator can let you carry on, redirect you, ' +
        'or stop you. Do not use this to ask a question — `ask_human` is for that.',
      inputSchema: {
        phase: z.string().describe('A few words naming the phase just finished'),
        done: z.string().describe('What you actually did in it'),
        next: z.string().describe('What you propose to do next, in one or two sentences')
      }
    },
    async (args, extra) => {
      const sessionId = io.sessionId
      try {
        const resolution = await io.held(extra, 'question.ask', {
          sessionId,
          origin: 'checkpoint',
          kind: 'choice',
          header: args.phase,
          question: `Finished: ${args.done}

  Proposed next: ${args.next}`,
          options: [
            { id: 'continue', label: 'Carry on', detail: 'Do exactly what you proposed.' },
            { id: 'redirect', label: 'Do something else', detail: 'Follow the note instead.' },
            { id: 'stop', label: 'Stop here', detail: 'Leave a handoff and end the run.' }
          ]
        })
        return { content: [{ type: 'text' as const, text: resolution.reply }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not reach the operator: ${String(err)}` }],
          isError: true
        }
      }
    }
  )

  /**
   * ⛔ The only signal that a task succeeded. The controller will not infer completion from a process
   * exiting, from a clean exit code, or from anything on screen.
   */
  def(
    'task_complete',
    {
      title: 'Report that the task is finished',
      description:
        'Call this when the work is done. The controller will run the project checks and land the branch ' +
        'according to project policy. Nothing else marks a task complete.',
      inputSchema: {
        summary: z.string().describe('One line: what was done'),
        pr_title: z
          .string()
          .optional()
          .describe(
            'When landing under pull-request: a concise, public-safe pull request title. Omit to let the controller summarize from commits.'
          ),
        prTitle: z.string().optional().describe('Alias for pr_title.'),
        pr_body: z
          .string()
          .optional()
          .describe(
            'When landing under pull-request: a public-safe pull request description. Omit to let the controller summarize from commits.'
          ),
        prBody: z.string().optional().describe('Alias for pr_body.')
      }
    },
    async (args, extra) => {
      const sessionId = io.sessionId
      const prTitle = args.pr_title ?? args.prTitle
      const prBody = args.pr_body ?? args.prBody
      try {
        await io.held(extra, 'agent.complete', {
          sessionId,
          summary: args.summary,
          ...(prTitle ? { prTitle } : {}),
          ...(prBody ? { prBody } : {})
        })
        return { content: [{ type: 'text' as const, text: 'Recorded. The controller is landing the work.' }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not report completion: ${String(err)}` }],
          isError: true
        }
      }
    }
  )

  /**
   * The other way a run can end: the agent has gone as far as it can, and the rest is a person's.
   *
   * ⛔ **Not a quieter `task_complete`, and the description must never let it read as one.** It claims
   * nothing about the work, lands nothing and runs no checks; the task comes to rest at
   * `awaiting_human` carrying the agent's own reason.
   *
   * ⭐ The gap it closes, measured on t226 (2026-09-05): an ordinary run stays open until
   * `task_complete` arrives, so an agent that is told *"leave it, I will close this out myself"* and
   * obeys has nothing to call. `task_complete` would assert a success the finish path had just refused,
   * `handoff` records a note and ends nothing, and `ask_human` asks a question it no longer has. The
   * turn ended, the session sat live and idle, and the board showed the task running all evening.
   */
  def(
    'await_human',
    {
      title: 'Hand the task back to a person and stop',
      description:
        'Call this when you have gone as far as you can and the rest genuinely needs a person: a step ' +
        'only they can take, a decision that is theirs to make, or work they have said they will close ' +
        'out themselves. It is NOT a way to finish early — if the work is done, call `task_complete`; ' +
        'if you only need an answer to carry on, call `ask_human`, which waits and lets you continue. ' +
        'This one ends the run. Nothing is landed, committed or discarded, and the task rests where a ' +
        'person can see your reason and reply. Stopping without calling this leaves the task reading ' +
        'as still running.',
      inputSchema: {
        reason: z
          .string()
          .describe('One line: what a person now has to decide or do. They see exactly this on the task.'),
        state: z
          .string()
          .optional()
          .describe(
            'Where things stand — what is done, what is not, and where the work is. Recorded as the ' +
              "handoff, so a successor does not pay to rediscover the state of the branch."
          )
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.awaitHuman', {
          sessionId,
          reason: args.reason,
          ...(args.state ? { state: args.state } : {})
        })
        return {
          content: [{ type: 'text' as const, text: result.reply }],
          ...(result.ok ? {} : { isError: true })
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not hand this over: ${String(err)}` }],
          isError: true
        }
      }
    }
  )

  /**
   * Ask the operator for a directory outside the workspace, and actually get it.
   *
   * ⛔ **`ask_human` could already ask this; what it could not do was answer it.** Measured on t469,
   * 2026-09-15: codex asked *"Grant write access to `C:\Dev\warmstart-site\.git` so the completed
   * changes can be committed"*, the operator typed *"Continue."*, and nothing about the sandbox
   * changed, because nothing a person can type into a thread widens one. The question reached them
   * and the answer had nowhere to go — the same failure `request_human` had, one layer down.
   *
   * ⛔ **And it is the one tool whose success ends the run.** A sandbox fixes what it may write before
   * the first token, so an approval can only ever reach the *next* process. The description says that
   * plainly, because an agent told it has been granted something and left running would spend the
   * rest of its turn retrying a write that is still refused.
   *
   * ⚠️ `state` is not optional in spirit. The next run is a resume, and a resumed prompt does not
   * restate the task — so whatever this turn worked out that the thread does not already say is lost
   * unless it is written down here.
   */
  def(
    'request_directory',
    {
      title: 'Ask the operator to grant a directory outside your workspace',
      description:
        'Call this when the work genuinely needs a directory outside your workspace and a read or ' +
        'write there was refused — not when a command failed for some other reason. Name the full ' +
        'absolute path and say why you need it. The operator gets a Grant / Don\u2019t grant card. ' +
        'If they refuse, or the path is wrong, or it was already granted, you are told so and carry ' +
        'on in this same turn. If they GRANT it, this run ENDS: a sandbox cannot be widened once its ' +
        'process has started, so the grant takes effect in a new run that resumes this same ' +
        'conversation. Put everything you have worked out into `state` — that run will not be told ' +
        'the task again. Ask once: asking for a directory you already have is refused.',
      inputSchema: {
        path: z
          .string()
          .describe('The full absolute path of the directory, e.g. C:\\Dev\\site or /Users/me/site'),
        reason: z
          .string()
          .describe(
            'Why the work needs it, in one line. The operator sees exactly this and is deciding ' +
              'whether to hand an agent write access to it.'
          ),
        state: z
          .string()
          .optional()
          .describe(
            'Where things stand — what is already done, what is left, and what you were about to do ' +
              'with this directory. Recorded as the handoff, and read by the run that picks the grant up.'
          )
      }
    },
    async (args, extra) => {
      const sessionId = io.sessionId
      try {
        const result = await io.held(extra, 'agent.requestDirectory', {
          sessionId,
          path: args.path,
          reason: args.reason,
          ...(args.state ? { state: args.state } : {})
        })
        // ⚠️ Never `isError`. A refusal is a real answer to a real question and the agent is meant to
        // read it and carry on; flagging it as a tool failure invites a retry of the call rather than
        // of the work.
        return { content: [{ type: 'text' as const, text: result.reply }] }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not reach the operator: ${String(err)}` }],
          isError: true
        }
      }
    }
  )

  /**
   * Land a conversation's committed work, mid-conversation, because a person asked for it.
   *
   * ⛔ **Still not a commit tool.** The agent commits with `git`, in its own workspace, exactly as it
   * would in any repository — deciding what to stage and what the message says is the work, not
   * plumbing, and [`landing.md`] is built on the daemon never authoring a commit. What this adds is the
   * step *after* the commit, which an agent genuinely could not do safely by hand: rebase onto a target
   * that has moved, run the project's own checks, and merge or push under the project's policy while
   * landing is serialised so two rebases cannot race.
   *
   * ⛔ **And it ends nothing.** `task_complete` and `await_human` are still the only two ways a run
   * ends. This one returns, the run stays open, the task is still an open conversation, and the reply
   * names the fresh branch to carry on in — because the branch it landed was retired by the landing.
   * That is the whole reason the description says *the conversation continues*: an agent that read this
   * as a quieter `task_complete` would stop talking to somebody who is still typing.
   *
   * ⚠️ Registering it changes the tool definitions, which invalidates the prompt-cache prefix of
   * **every** worker session on the install, not only conversations — a session's MCP config is frozen
   * for its lifetime and workers on one project get identical configs. Same price `checkpoint` and
   * `task_split` pay, and the same mitigation: registered for everyone, named in the prompt only where
   * it applies. See mcp.md §2.
   */
  def(
    'land_work',
    {
      title: 'Land this conversation\'s committed work',
      description:
        'In a conversation, after you have committed: call this when the person has asked you to land ' +
        'the work. It rebases your branch onto the landing target, runs the project checks, and merges ' +
        'or pushes according to the project policy. Commit first with `git` yourself — this does not ' +
        'commit — and never merge or push to the target by hand. It is NOT `task_complete` and it ends ' +
        'nothing: the conversation carries on, and the reply names the new branch to keep working on. ' +
        'It refuses on anything that is not a conversation, and on a landing that would not be safe, ' +
        'and tells you why.',
      inputSchema: {
        summary: z
          .string()
          .optional()
          .describe('One line: what this landing contains. Recorded on the thread beside it.'),
        finishPolicy: z
          .enum(['commit-and-merge', 'commit-and-push', 'pull-request'])
          .optional()
          .describe(
            'How far to take it, when the person named one. Omit to use the project\'s own policy.'
          ),
        pr_title: z
          .string()
          .optional()
          .describe(
            'When landing under pull-request: a concise, public-safe pull request title. Omit to let the controller summarize from commits.'
          ),
        prTitle: z.string().optional().describe('Alias for pr_title.'),
        pr_body: z
          .string()
          .optional()
          .describe(
            'When landing under pull-request: a public-safe pull request description. Omit to let the controller summarize from commits.'
          ),
        prBody: z.string().optional().describe('Alias for pr_body.'),
        set_aside: z
          .array(z.number().int())
          .optional()
          .describe(
            'Delegated pieces (t-numbers, digits only) you reviewed and deliberately did not merge. ' +
              'Without this, a landing is refused while a completed piece’s branch is not in yours.'
          )
      }
    },
    async (args, extra) => {
      const sessionId = io.sessionId
      const prTitle = args.pr_title ?? args.prTitle
      const prBody = args.pr_body ?? args.prBody
      try {
        const result = await io.held(extra, 'agent.land', {
          sessionId,
          ...(args.summary ? { summary: args.summary } : {}),
          ...(args.finishPolicy ? { finishPolicy: args.finishPolicy } : {}),
          ...(prTitle ? { prTitle } : {}),
          ...(prBody ? { prBody } : {}),
          ...(args.set_aside?.length ? { setAside: args.set_aside } : {})
        })
        if (!result.ok) {
          // ⚠️ The daemon's reason, verbatim and alone. Every one of them names a condition that
          // failed, and most are something the agent can fix in `git`; rewording it here would lose
          // the only sentence that says what to do next.
          return {
            content: [{ type: 'text' as const, text: `Nothing was landed: ${result.reason}` }],
            isError: true
          }
        }
        return {
          content: [
            {
              type: 'text' as const,
              text:
                // ⚠️ A trunk conversation gets no `nextBranch` — its commits were already on the
                // target — and this used to read "continues on undefined" (t649).
                result.nextBranch && result.branch
                  ? conversationLandingResultText(
                    result.landedSha?.slice(0, 8) ?? 'unknown',
                    result.branch,
                    result.target ?? 'unknown',
                    result.nextBranch
                  )
                  : `This conversation continues in the trunk on ${result.target} — no branch to switch to. ` +
                    'The task is not finished; carry on.'
            }
          ]
        }
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not land: ${String(err)}` }],
          isError: true
        }
      }
    }
  )

  /**
   * Agent-authored work. Bounded by the calling task's inherited mandate and budget - a task that has
   * lost `spawn_tasks` simply cannot do this, and the refusal comes from the daemon, not from here.
   */
  def(
    'task_create',
    {
      title: 'File a follow-up task',
      description:
        'File work that should not be part of this task. It inherits a narrowed version of this ' +
        "task's authority and a share of its budget. Pass `aggregate` when you will review and land " +
        'the piece yourself: it branches off your branch and merges back into it, and nothing ' +
        'reaches the trunk until you land it. Telling the piece "do not land to main" in its prompt ' +
        'cannot do this — landing is the daemon\u2019s job, not the agent\u2019s, so the finish policy ' +
        'would merge it onto the trunk anyway.',
      inputSchema: {
        title: z.string(),
        prompt: z.string().optional(),
        assignee_hint: z.enum(['human', 'any']).optional(),
        aggregate: z
          .boolean()
          .optional()
          .describe(
            'File this as a piece you will aggregate: it lands into your own branch, not the ' +
              'project\u2019s target. Omit it for standalone work that should land normally.'
          )
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.createTask', {
          sessionId,
          title: args.title,
          ...(args.prompt ? { prompt: args.prompt } : {}),
          ...(args.assignee_hint ? { assigneeHint: args.assignee_hint } : {}),
          ...(args.aggregate ? { aggregate: true } : {})
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: result.ok
                ? `Filed as t${result.seq}.` + (result.landingTarget ? ` Landing into ${result.landingTarget}.` : '')
                : `Not filed: ${result.reason}`
            }
          ]
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
      }
    }
  )

  /**
   * File a whole plan at once, and block on the operator approving it.
   *
   * ⛔ **The approval is structural, not an instruction.** An agent told in its prompt to ask before
   * splitting can forget, or can decide this particular split is obvious; an agent whose `task_split`
   * call does not return until a person has answered cannot. That is the whole reason this blocks
   * rather than filing and notifying.
   *
   * ⛔ **One approval for the whole split, not one per child.** Every coding subtask trips `riskOf`'s
   * `controller` gate — any agent-filed task whose mandate allows `commit` or `push` does — so a split
   * of five would otherwise raise five separate consults and leave five drafts, and on an install with
   * no controller turn available none of them would ever run. The operator approved this exact set, by
   * title, one second ago; asking again five times is not a second safety check, it is a way to make
   * the feature unusable.
   *
   * ⚠️ Atomic. Nothing is written until the operator says yes, and if any piece cannot be filed the
   * ones already created are unwound — a planner blocked on half a plan has no way out.
   */
  def(
    'task_split',
    {
      title: 'Delegate work to other agents, or break a plan into subtasks',
      description:
        'File work for other agents in one call, as concrete pieces each with its own full ' +
        'instruction. A Plan & Split or Plan & Execute uses it to file its plan; any other task or ' +
        'conversation uses it to delegate, when delegation is on for it (you are refused with the ' +
        'reason when it is not). The operator approves the pieces before anything is filed — unless ' +
        'they asked for this delegation with /delegate — so make each piece legible on a card. Each ' +
        'piece must be completable by an agent that has NOT read this conversation, so its ' +
        'instruction has to carry its own context: what to change, where, and what done looks like. ' +
        'Pieces without dependency edges may run in parallel. If the plan calls for sequential ' +
        'execution or landing, encode that order with depends_on; otherwise add an edge only where it ' +
        'is genuinely needed, because it costs a subtask’s wait. HOW MANY PIECES is decided by the ' +
        'task, not by you, and your own instructions say which: a Plan & Split files two or more and ' +
        'you are woken again when every piece has settled; a Plan & Execute files exactly one and is ' +
        'complete at the handoff; a delegation files one or more, each committed on its own branch ' +
        'for you to review and merge when you are told they have settled. After this returns, do ' +
        'what its reply says — the delegated work is no longer yours to do.',
      inputSchema: {
        pieces: z
          .array(
            z.object({
              instruction: z
                .string()
                .describe('The full prompt for this piece, self-contained. This is what the agent is sent.'),
              summary: z
                .string()
                .optional()
                .describe('A short label for the board, e.g. "Add the migration"'),
              tags: z
                .array(z.string())
                .optional()
                .describe(
                  'Optional tags the model/effort pair running this piece must ALL carry, e.g. ["Low"] for ' +
                    'mechanical work a cheaper model can do, ["High"] for hard reasoning, or an operator tag ' +
                    'such as "ZDR". The scheduler picks the account; a tag nothing carries holds the piece.'
                ),
              class: z
                .enum(['low', 'med', 'high'])
                .optional()
                .describe('Older spelling of one tag: low, med or high. Prefer tags.'),
              adapter: z
                .string()
                .optional()
                .describe(
                  'Optional target adapter type or command alias (e.g. "openai-compatible", "codex", ' +
                    '"claude-code", "claude", "antigravity-cli", "antigravity", "agy", "muse-code", "muse").'
                ),
              worker: z
                .string()
                .optional()
                .describe('Optional target worker label or UUID (e.g. "CodexFirst", "ClaudeFirst").'),
              model: z
                .string()
                .optional()
                .describe('Optional target model name (e.g. "gpt-5-codex", "claude-sonnet-5-5").'),
              effort: z
                .string()
                .optional()
                .describe('Optional reasoning effort level where supported (e.g. "low", "medium", "high").'),
              depends_on: z
                .array(z.number().int())
                .optional()
                .describe(
                  'Indices of EARLIER pieces this piece must wait for, starting at 0. Use these to ' +
                    'encode every promised execution or landing order; omitted pieces may run in parallel.'
                )
            })
          )
          .optional()
          .describe(
            'As many pieces as this task allows: two or more for a Plan & Split, exactly one for a ' +
              'Plan & Execute, one or more for a delegation. Anything else is refused with the reason.'
          ),
        approval: z
          .string()
          .optional()
          .describe(
            'Instead of `pieces`: the approval card id an earlier task_split reply gave you, once the ' +
              'operator has answered it. Files exactly the pieces they approved; do not send them again.'
          )
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.split', {
          sessionId,
          ...(args.approval ? { approval: args.approval } : {}),
          pieces: (args.pieces ?? []).map((p) => ({
            title: p.instruction,
            ...(p.summary ? { summary: p.summary } : {}),
            ...(p.tags?.length ? { modelTags: p.tags } : {}),
            ...(p.class ? { modelClass: p.class } : {}),
            ...(p.adapter ? { adapter: p.adapter } : {}),
            ...(p.worker ? { worker: p.worker } : {}),
            ...(p.model ? { model: p.model } : {}),
            ...(p.effort ? { effort: p.effort } : {}),
            dependsOn: p.depends_on ?? []
          }))
        })
        return {
          content: [{ type: 'text' as const, text: result.reply }],
          ...(result.ok ? {} : { isError: true })
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
      }
    }
  )

  /**
   * The debate organizer's only move, called once per round.
   *
   * ⛔ **One tool, and it is not free.** Changing tool definitions invalidates the whole prompt-cache
   * prefix, and a session's MCP config is frozen for its lifetime, so **every** worker session on
   * this install pays for this — not only debates. `docs/mcp.md` §2 says so by name, and
   * `checkpoint`, `task_split` and `land_work` each paid it before. Same mitigation: registered for
   * everyone, named in the prompt only for a debate organizer.
   *
   * ⛔ **Not three tools, and not a third tier.** A separate `debate_post` for seats buys nothing —
   * a seat's position is already carried by `task_complete`'s summary, which is already written onto
   * the thread — and a third tier would buy a third prompt-cache prefix on the install.
   *
   * ⛔ **The converged call BLOCKS until a person answers**, the way `task_split` blocks on its
   * approval. An organizer told in its prompt to ask before acting can forget; an organizer whose
   * tool call does not return until the operator has chosen cannot.
   */
  def(
    'debate_round',
    {
      title: 'Arbitrate this round of the debate',
      description:
        'The debate organizer calls this ONCE per round, in one of two shapes. Either continue: ' +
        'pass `continue: true` and one brief per seat, each naming the SPECIFIC disagreement that ' +
        'seat must address — the seats are re-queued and you are stopped until they answer. Or ' +
        'converge: pass `converged: true` with the agreement, the dissent, your confidence and what ' +
        'is unresolved — this raises a card with five choices and BLOCKS until a person answers, and ' +
        'the reply tells you what to do next. ⛔ An empty dissent is refused: if there genuinely was ' +
        'no disagreement, say that in the dissent field and say what was never contested. You may ' +
        'converge early; you may not ask for more rounds than the operator authorised.',
      inputSchema: {
        continue: z
          .boolean()
          .optional()
          .describe('Open another round. Requires one brief per seat, and rounds remaining.'),
        briefs: z
          .array(
            z.object({
              seat: z.number().int().describe('The seat number, starting at 1, as labelled in your prompt.'),
              text: z.string().describe('What this seat must address next. Name the specific disagreement.')
            })
          )
          .optional()
          .describe('One per seat, in any order. Required with `continue`.'),
        converged: z.boolean().optional().describe('Report the agreement and ask the operator what happens next.'),
        agreement: z.string().optional().describe('What to do, concretely enough to execute.'),
        dissent: z
          .string()
          .optional()
          .describe('Who disagreed, with what, on what grounds. ⛔ Never empty — see the description.'),
        confidence: z.string().optional().describe('Your own confidence in this agreement, with the reason.'),
        unresolved: z.string().optional().describe('What the debate did not settle, and what would settle it.')
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.debateRound', {
          sessionId,
          ...(args.continue === undefined ? {} : { continue: args.continue }),
          ...(args.briefs ? { briefs: args.briefs } : {}),
          ...(args.converged === undefined ? {} : { converged: args.converged }),
          ...(args.agreement ? { agreement: args.agreement } : {}),
          ...(args.dissent ? { dissent: args.dissent } : {}),
          ...(args.confidence ? { confidence: args.confidence } : {}),
          ...(args.unresolved ? { unresolved: args.unresolved } : {})
        })
        return {
          content: [{ type: 'text' as const, text: result.reply }],
          ...(result.ok ? {} : { isError: true })
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
      }
    }
  )

  /**
   * Add one edge between two pieces of this planner's own split.
   *
   * ⛔ Scoped to this task's own children, and the daemon enforces it rather than trusting the
   * argument. An agent that can add an arbitrary edge anywhere in the fleet can hold up work it has
   * never seen; the blast radius of a mistake here is the plan the agent is holding, and nothing else.
   *
   * ⚠️ Usually unnecessary — `task_split` takes the edges inline, which is one call instead of N. This
   * exists for the ordering a planner only realises it needs after seeing the pieces filed.
   */
  def(
    'task_depend',
    {
      title: 'Make one piece of this plan wait for another',
      description:
        'Add a dependency between two pieces of THIS task’s split, by their t-numbers. The blocked ' +
        'piece will not be dispatched until the one it needs has completed. Prefer passing depends_on ' +
        'to task_split; use this only for an ordering you discovered afterwards.',
      inputSchema: {
        task: z.number().int().describe('The t-number of the piece that must WAIT'),
        depends_on: z.number().int().describe('The t-number of the piece it waits FOR')
      }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        const result = await io.rpc('agent.depend', {
          sessionId,
          taskSeq: args.task,
          dependsOnSeq: args.depends_on
        })
        return {
          content: [
            {
              type: 'text' as const,
              text: result.ok
                ? `t${args.task} now waits for t${args.depends_on}.`
                : `Not added: ${result.reason}`
            }
          ],
          ...(result.ok ? {} : { isError: true })
        }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
      }
    }
  )

  def(
    'handoff',
    {
      title: 'Leave a note for whoever continues this task',
      description:
        'Record what you were doing, what is done and what the next step is. Prepended to the next ' +
        "session's prompt, so a successor does not pay to rediscover the state of the branch.",
      inputSchema: { note: z.string() }
    },
    async (args) => {
      const sessionId = io.sessionId
      try {
        await io.rpc('agent.handoff', { sessionId, note: args.note })
        return { content: [{ type: 'text' as const, text: 'Handoff recorded.' }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: String(err) }], isError: true }
      }
    }
  )


  return tools
}
