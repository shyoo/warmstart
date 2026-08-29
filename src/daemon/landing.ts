import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LandingResult, LandingStrategyId, Project, Task } from '@shared/tasks.js'
import { policyFor } from './projects.js'
import { claim, landResourceId, release, upsertResource } from './resources.js'
import { addMessage, mandateAllows, setStatus } from './tasks.js'
import { landedRef } from './worktrees.js'
import { launchArgs, which } from './which.js'
import { log } from './log.js'

const run = promisify(execFile)

/**
 * Landing: what happens to a task's branch when the work is done.
 *
 * A **strategy interface**, not a branch in the code, because different projects genuinely want
 * different flows and the tool should not have an opinion about which. v1 ships `auto-land`;
 * `leave-branch` is the fallback everything degrades to; `pull-request` slots in later without the
 * scheduler, the workspace pool or the task model changing.
 *
 * ⛔ **Landing is serialised per project.** Three workspaces finishing at once would each rebase onto
 * an `origin/main` the other two are about to move, and the second and third would race. So landing
 * takes an exclusive `land:<project>` resource - which is not a special case, it is §10 doing exactly
 * what it exists for.
 */

export interface LandingContext {
  project: Project
  task: Task
  workspacePath: string
  branch: string
}

export interface LandingStrategy {
  id: LandingStrategyId
  canLand(ctx: LandingContext): Promise<{ ok: boolean; reason?: string }>
  land(ctx: LandingContext): Promise<LandingResult>
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 })
  return stdout.trim()
}

async function hasRemote(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['remote', 'get-url', 'origin'])
    return true
  } catch {
    return false
  }
}

async function isClean(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])).length === 0
}

/**
 * Say where the work actually is.
 *
 * ⚠️ This used to be one sentence — "The branch `x` is intact" — and on 2026-08-26 it was true and
 * useless at the same time. The branch existed, pointed at the base commit, and contained none of
 * the change; the only copy was an uncommitted file in a **pooled** workspace that the next dispatch
 * would have switched out from under. A branch name is not a location. A person reading this needs
 * to know whether their work survived and where to go and look for it.
 */
async function whereTheWorkIs(cwd: string, branch: string): Promise<string> {
  const dirty = (await git(cwd, ['status', '--porcelain'])).split('\n').filter(Boolean)
  const carried = (await git(cwd, ['log', '--oneline', branch, '--not', '--remotes', '--']))
    .split('\n')
    .filter(Boolean)

  if (dirty.length === 0) {
    return carried.length > 0
      ? `${carried.length} commit(s) are on \`${branch}\`, which is intact.`
      : `⚠️ Nothing was committed and nothing is uncommitted — \`${branch}\` holds no work.`
  }

  const named = dirty.slice(0, 5).map((line) => line.slice(3)).join(', ')
  const more = dirty.length > 5 ? `, +${dirty.length - 5} more` : ''
  const alsoCommitted =
    carried.length > 0
      ? ` \`${branch}\` does hold ${carried.length} earlier commit(s).`
      : ` \`${branch}\` holds no commits.`

  return (
    `⚠️ ${dirty.length} file(s) are **uncommitted** in \`${cwd}\` (${named}${more}) and are NOT on ` +
    `\`${branch}\`.${alsoCommitted} That workspace is pooled and will be reused, so commit or copy ` +
    `the work out before dispatching anything else.`
  )
}

/**
 * How many commits this branch carries that the landing target does not.
 *
 * ⛔ Asked **before** anything is landed, because zero is a completely different situation from one.
 * Measured on this machine 2026-08-27: a question-only task - "how long does the quota take to show
 * up?" - was answered, changed no file, and was then reported as *"Landed as a166a6a onto main"*.
 * Every step had succeeded: the workspace was clean, the rebase was a no-op, the checks passed, the
 * push moved nothing, and `rev-parse HEAD` dutifully returned the commit that was already there. A
 * pipeline of correct steps produced a sentence that was false.
 *
 * ⚠️ Counted against the **target**, not against `--remotes`. A branch can be ahead of every remote
 * and still carry nothing new for `main`.
 */
async function commitsAhead(cwd: string, branch: string, base: string): Promise<number | null> {
  try {
    return Number.parseInt(await git(cwd, ['rev-list', '--count', `${base}..${branch}`]), 10) || 0
  } catch {
    // An unknown base is not proof of an empty branch, and guessing here would silently skip landing
    // real work. Unknown means "carry on and let the strategy decide".
    return null
  }
}

/** Run the project's own checks. A project that declares none has consented to landing unchecked. */
async function runChecks(
  project: Project,
  cwd: string
): Promise<{ ok: boolean; output: string }> {
  const commands = policyFor(project).check
  let output = ''
  for (const command of commands) {
    try {
      const result = await run(command, {
        cwd,
        shell: true,
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30 * 60 * 1000
      } as never)
      output += `$ ${command}\n${result.stdout}${result.stderr}\n`
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string }
      output += `$ ${command}\n${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}\n`
      return { ok: false, output: output.slice(-8000) }
    }
  }
  return { ok: true, output: output.slice(-8000) }
}

export const leaveBranch: LandingStrategy = {
  id: 'leave-branch',
  async canLand() {
    return { ok: true }
  },
  async land(ctx) {
    return { strategy: 'leave-branch', ok: true, branch: ctx.branch }
  }
}

export const autoLand: LandingStrategy = {
  id: 'auto-land',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'land')) {
      return { ok: false, reason: 'the task has no authority to land' }
    }
    if (ctx.task.verification === 'required') {
      return { ok: false, reason: 'task requires human verification before landing' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const policy = policyFor(ctx.project)
    const target = policy.landingTarget

    // ⛔ Exclusive for the whole of rebase-check-push. Released in `finally` without exception.
    upsertResource({
      id: landResourceId(ctx.project.id),
      projectId: ctx.project.id,
      kind: 'exclusive',
      label: `${ctx.project.name} landing`,
      capacity: 1
    })
    const lock = claim(landResourceId(ctx.project.id), ctx.task.id)
    if (!lock) {
      return { strategy: 'auto-land', ok: false, reason: 'another task is landing right now' }
    }

    try {
      const remote = await hasRemote(ctx.workspacePath)
      if (remote) await git(ctx.workspacePath, ['fetch', 'origin', '--prune'])
      const base = remote ? `origin/${target}` : target

      try {
        await git(ctx.workspacePath, ['rebase', base])
      } catch (err) {
        // Leave nothing half-rebased for a person to discover later.
        await git(ctx.workspacePath, ['rebase', '--abort']).catch(() => undefined)
        return {
          strategy: 'auto-land',
          ok: false,
          branch: ctx.branch,
          reason: `rebase onto ${base} conflicted: ${err instanceof Error ? err.message : String(err)}`
        }
      }

      const checks = await runChecks(ctx.project, ctx.workspacePath)
      if (!checks.ok) {
        return {
          strategy: 'auto-land',
          ok: false,
          branch: ctx.branch,
          reason: 'the project checks failed after rebase',
          checkOutput: checks.output
        }
      }

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])

      if (remote) {
        await git(ctx.workspacePath, ['push', 'origin', `HEAD:${target}`])
      } else {
        // No remote: fast-forward the local target in the trunk instead. Same outcome, no invention.
        await git(ctx.project.root, ['fetch', ctx.workspacePath, `${ctx.branch}:${target}`])
      }

      await git(ctx.workspacePath, ['switch', '--detach', commit])
      await git(ctx.workspacePath, ['branch', '-D', ctx.branch]).catch(() => undefined)

      log.info(`landed t${ctx.task.seq} (${commit.slice(0, 8)}) onto ${target}`)
      return { strategy: 'auto-land', ok: true, commit, checkOutput: checks.output }
    } catch (err) {
      return {
        strategy: 'auto-land',
        ok: false,
        branch: ctx.branch,
        reason: err instanceof Error ? err.message : String(err)
      }
    } finally {
      release(lock.id)
    }
  }
}

/**
 * Open a pull request instead of landing.
 *
 * ⛔ **`gh` is wrapped, never vendored** (D7). GitHub's API is a moving target with auth agentyard
 * has no business holding; `gh` already solves both and the operator already has it configured. If it
 * is absent, this refuses *before* doing anything rather than pushing a branch and then discovering
 * it cannot open the PR.
 *
 * ⚠️ The important difference from `auto-land`: this **does not rebase and does not run the project
 * checks**. A pull request exists so that CI and a person do that. Rebasing here would rewrite a
 * branch somebody is about to review, and running checks locally would duplicate what the PR is for.
 */
export const pullRequest: LandingStrategy = {
  id: 'pull-request',

  async canLand(ctx) {
    if (ctx.project.vcs !== 'git') return { ok: false, reason: 'project is not a git repository' }
    if (!mandateAllows(ctx.task, 'push')) {
      // ⛔ `push`, not `land`. Opening a PR does not put anything on the trunk, so it needs the
      // narrower authority - and a task that may only push should be able to use this strategy.
      return { ok: false, reason: 'the task has no authority to push' }
    }
    if (!(await isClean(ctx.workspacePath))) {
      return { ok: false, reason: 'the workspace has uncommitted changes' }
    }
    if (!(await hasRemote(ctx.workspacePath))) {
      return { ok: false, reason: 'no origin remote, so there is nowhere to open a pull request' }
    }
    if (!which('gh')) {
      return {
        ok: false,
        reason:
          'the GitHub CLI (`gh`) is not on PATH. Multi Agent Controller wraps it rather than talking to the ' +
          'GitHub API itself, so that it never holds a token of yours. Install it, or set the ' +
          "project's landing strategy to `leave-branch`."
      }
    }
    return { ok: true }
  },

  async land(ctx): Promise<LandingResult> {
    const policy = policyFor(ctx.project)
    try {
      // ⛔ Push first and separately. If the PR call fails, the work is already safe on the remote
      // and the operator can open one by hand - which is a much better failure than a branch that
      // exists only on this machine.
      await git(ctx.workspacePath, ['push', '--set-upstream', 'origin', ctx.branch])

      const commit = await git(ctx.workspacePath, ['rev-parse', 'HEAD'])
      const title = `t${ctx.task.seq}: ${ctx.task.title}`.slice(0, 120)
      const body = [
        ctx.task.handoffNote ? `${ctx.task.handoffNote}\n` : '',
        `Opened by Multi Agent Controller for task t${ctx.task.seq}.`,
        '',
        `- branch: \`${ctx.branch}\``,
        `- base: \`${policy.landingTarget}\``,
        '',
        '⚠️ Written by an agent. The project checks were **not** run locally — that is what this ' +
          'pull request is for.'
      ].join('\n')

      const resolved = which('gh')
      if (!resolved) throw new Error('gh vanished between the check and the call')
      const call = launchArgs(resolved, [
        'pr',
        'create',
        '--base',
        policy.landingTarget,
        '--head',
        ctx.branch,
        '--title',
        title,
        '--body',
        body
      ])
      const { stdout } = await run(call.command, call.args, {
        cwd: ctx.workspacePath,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 120_000
      })

      // `gh pr create` prints the URL and nothing else worth having.
      const prUrl = stdout.trim().split(/\s+/).find((line) => line.startsWith('http')) ?? undefined
      log.info(`opened a pull request for t${ctx.task.seq}: ${prUrl ?? 'url not reported'}`)
      return {
        strategy: 'pull-request',
        ok: true,
        commit,
        branch: ctx.branch,
        ...(prUrl ? { prUrl } : {})
      }
    } catch (err) {
      // ⚠️ The branch is pushed by now in most failure paths, which is deliberate. Say so, rather
      // than leaving somebody to guess whether their work escaped the machine.
      return {
        strategy: 'pull-request',
        ok: false,
        branch: ctx.branch,
        reason:
          `${err instanceof Error ? err.message : String(err)} ` +
          `(the branch \`${ctx.branch}\` may already be pushed - check the remote before redoing work)`
      }
    }
  }
}

const STRATEGIES: Record<LandingStrategyId, LandingStrategy> = {
  'auto-land': autoLand,
  'leave-branch': leaveBranch,
  'pull-request': pullRequest
}

export function strategyFor(project: Project): LandingStrategy {
  return STRATEGIES[policyFor(project).landingStrategy] ?? leaveBranch
}

/**
 * Land, or fall back honestly.
 *
 * ⛔ Nothing is ever forced. A task that cannot land keeps its branch, gets an `awaiting_human` entry
 * that says exactly why, and leaves the repository in a state a person can act on.
 */
export async function landTask(ctx: LandingContext): Promise<LandingResult> {
  const strategy = strategyFor(ctx.project)

  // ⛔ Before the strategy, and only when the workspace is clean. A task that produced **no commits**
  // has nothing to land, and saying "landed as <the commit that was already there>" is not a
  // harmless overstatement - it tells somebody their change reached the trunk. Uncommitted work is a
  // different case entirely and is left to `canLand`, which refuses it and says where the work is.
  // ⚠️ Not for a task that asked to be checked. "Nothing landed" is still an outcome its author
  // wanted to see before it was called done, and skipping the review because the diff turned out
  // empty decides that for them.
  if (
    ctx.project.vcs === 'git' &&
    ctx.task.verification !== 'required' &&
    (await isClean(ctx.workspacePath))
  ) {
    const target = policyFor(ctx.project).landingTarget
    const base = await landedRef(ctx.workspacePath, target)
    if ((await commitsAhead(ctx.workspacePath, ctx.branch, base)) === 0) {
      // ⛔ **Names the ref it compared.** This said `main` while comparing `origin/main`, which is
      // not a wording quibble: on 2026-08-29 t22's agent pushed its own commit to `origin/main`, and
      // the operator was told the branch carried nothing `main` did not have while their `main` was
      // two commits short of it. A message that names the wrong ref is worse than no message,
      // because it is checkable and it checks out false.
      // ⚠️ `?? 0` because a base git cannot resolve is not evidence the trunk is behind.
      const behind = (await commitsAhead(ctx.workspacePath, base, target)) ?? 0
      addMessage(
        ctx.task.id,
        'system',
        `Nothing to land: \`${ctx.branch}\` carries no commits that \`${base}\` does not already ` +
          'have, and the workspace is clean.' +
          (behind > 0
            ? ` The work reached \`${base}\` without passing through here — your \`${target}\` is ` +
              `${behind} commit(s) behind it, so run \`git pull\` in the trunk to see it.`
            : ' Work that answers a question rather than changing a file is finished here — the ' +
              'trunk was not touched.')
      )
      return { strategy: strategy.id, ok: true, branch: ctx.branch, nothingToLand: true }
    }
  }

  const allowed = await strategy.canLand(ctx)

  if (!allowed.ok) {
    const fallback = await leaveBranch.land(ctx)
    addMessage(
      ctx.task.id,
      'system',
      `Not landed automatically: ${allowed.reason}. ` +
        (await whereTheWorkIs(ctx.workspacePath, ctx.branch))
    )
    setStatus(ctx.task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `the work is done but did not land: ${allowed.reason}`
    })
    return { ...fallback, ok: false, reason: allowed.reason }
  }

  const result = await strategy.land(ctx)
  if (!result.ok) {
    addMessage(
      ctx.task.id,
      'system',
      `Landing failed: ${result.reason}. ` +
        (await whereTheWorkIs(ctx.workspacePath, ctx.branch)) +
        (result.checkOutput ? `\n\n${result.checkOutput.slice(-2000)}` : '')
    )
    setStatus(ctx.task.id, 'awaiting_human', {
      assignee: 'human',
      holdReason: `landing failed: ${result.reason}`
    })
  } else {
    addMessage(
      ctx.task.id,
      'system',
      `Landed as ${result.commit?.slice(0, 8)} onto ${policyFor(ctx.project).landingTarget}.`
    )
  }
  return result
}
