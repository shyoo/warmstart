/**
 * `project_settings`: the project's landing setup, told to the agent working in it (t906).
 *
 * ⭐ **t905 is why.** Its agent redid a fork's docs, then ended by asking the operator to *"confirm
 * this project's Warmstart finish policy is commit-and-merge or commit-and-push into the fork … I
 * can't see that setting from here"*. Everything it needed was in `project.json` and the remotes; the
 * prompt names the landing target and nothing else. So this answers the question the way the landing
 * itself will: the same resolvers (`resolveFinishPolicy`, `landingLevel`, `policyFor`), not a copy.
 *
 * ⛔ **Read-only, and the reply says so.** Preference never widens authority, and an agent that could
 * set its own finish policy could promote its work past the review the operator chose. What it gets
 * instead is `howToChange` — where a *person* changes each setting — and `observations`, so a
 * recommendation can name the control rather than describe it.
 *
 * ⚠️ The pure half (`projectBrief`) takes the remotes as data; `readProjectBrief` is the one place
 * that asks git. Remote URLs lose any userinfo before they leave: an `https://user:token@host` remote
 * is a credential in a config file, and a tool reply is transcript text.
 */
import {
  COMPLETION_LABELS,
  finishLabel,
  SHARING_LABELS,
  policyLands,
  policyVerifies,
  resolveWorkspaceMode,
  type FinishPolicy,
  type Project,
  type Task
} from '@shared/tasks.js'
import { resolveCompletionMode } from '@shared/policy.js'
import type { AgentProjectSettings } from '@shared/protocol.js'
import { landingLevel, resolveFinishPolicy } from './finish.js'
import { landingTargetFor, policyFor, reloadProjectIfPresent } from './projects.js'
import { resolveSessionSharing } from './sharing.js'
import { settings } from './settings.js'
import { tryGit } from './git.js'
import { landingTargetFound } from './worktrees.js'
import { getTask, runForSession } from './tasks.js'

export interface RemoteEntry {
  name: string
  url: string
}

/** `git remote -v` → one entry per remote (its fetch URL), with any `user:pass@` removed. */
export function parseRemotes(out: string | null): RemoteEntry[] {
  const seen = new Map<string, string>()
  for (const line of (out ?? '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)(?:\s+\((fetch|push)\))?$/.exec(line.trim())
    const [, name, url, kind] = m ?? []
    if (!name || !url) continue
    if (!seen.has(name) || kind === 'fetch') seen.set(name, redactUrl(url))
  }
  return [...seen].map(([name, url]) => ({ name, url }))
}

/** Strip userinfo from a URL-shaped remote. `git@host:owner/repo` has none worth hiding. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1')
}

/** What the tool does once the agent reports, at this level, in the order it happens. */
function whatHappens(
  level: FinishPolicy,
  target: string,
  checks: string[],
  pushRemote: string | null,
  upstreamRemote: string | null,
  inTrunk: boolean,
  instruction: string | null
): string {
  const checkText = checks.length > 0 ? `runs the checks (${checks.map((c) => `\`${c}\``).join(', ')})` : 'finds no check commands declared and stops there for a person'
  const where = inTrunk ? `Your commits are already on \`${target}\` in the trunk checkout. ` : ''
  switch (level) {
    case 'await-human':
      return `${where}Nothing is landed. The branch is kept as it is and a person decides what happens to it.`
    case 'commit-only':
      return `${where}Your commits stay where they are. Nothing is verified, merged or pushed; a person lands them.`
    case 'commit-and-verify':
      return checks.length > 0
        ? `${where}Warmstart ${checkText} against your commits and reports the verdict on the thread. Nothing is merged.`
        : `${where}Your commits stay on the branch and nothing is merged; there are no check commands to verify them with.`
    case 'commit-and-merge':
      return (
        `${where}Warmstart rebases onto \`${target}\`, ${checkText}, then fast-forwards the local ` +
        `\`${target}\` in the main checkout and retires the branch. Nothing is pushed.`
      )
    case 'commit-and-push':
      return (
        `${where}Warmstart rebases onto \`${target}\`, ${checkText}, fast-forwards the local \`${target}\` ` +
        `and pushes it to \`origin\`` +
        (upstreamRemote ? ` (your fork — never to \`${upstreamRemote}\`)` : '') +
        '. Landing is measured against `origin/' + target + '`.'
      )
    case 'pull-request':
      return (
        `Warmstart pushes the task branch to \`${pushRemote ?? 'origin'}\` and opens a pull request ` +
        `onto \`${target}\`; a person merges it. ` +
        (upstreamRemote ? `Never onto \`${upstreamRemote}\`: that only happens from Propose upstream. ` : '') +
        'Do not push or run `gh pr create` yourself.'
      )
    case 'custom':
      return `Warmstart does not land anything itself; you were told to finish this way: ${instruction ?? '(no instruction set)'}`
    case 'report-only':
      return 'The deliverable is your reply on the thread. Nothing is expected on the branch, and anything committed becomes a loose end.'
  }
}

/** The pure half. `remotes` is `git remote -v` already parsed; empty for a non-git project. */
export function projectBrief(
  task: Task,
  project: Project,
  remotes: RemoteEntry[],
  /** Whether the target names a branch here or on origin; null when nobody looked. */
  targetFound: boolean | null = null
): AgentProjectSettings {
  const policy = policyFor(project)
  const finish = resolveFinishPolicy(task, project)
  const level = landingLevel(task, project)
  const target = landingTargetFor(task, project)
  const workspace = resolveWorkspaceMode(task, project)
  const inTrunk = workspace.mode === 'trunk'
  const checks = policyVerifies(level) ? policy.check : []
  const completion = resolveCompletionMode(task, project, settings().completionMode)
  const sharing = resolveSessionSharing(task, project)
  const allowed = task.mandate.allowed
  const mayLand = allowed.includes('land')
  const mayPush = allowed.includes('push')

  const role = (name: string): string => {
    if (name === policy.upstreamRemote) return 'the repository this project contributes to — nothing lands here; only a person’s Propose upstream reaches it'
    if (name === policy.pushRemote) return 'where task branches are pushed (a fork); pull requests open from here onto origin'
    if (name === 'origin') {
      if (policy.upstreamRemote) return `your fork, and home: every landing goes here, measured against origin/${target}`
      if (policy.pushRemote) return 'the repository the work is for; landings are measured against it, but branches are pushed to the fork'
      return `home: landings are measured against origin/${target}`
    }
    return 'not used by Warmstart'
  }

  // ⛔ The same two gates `decideFinish` applies to the levels that move the trunk, in its order:
  //    authority first, then something proving the work builds.
  const movesTrunk = level === 'commit-and-merge' || level === 'commit-and-push'
  const observations: string[] = []
  if (policyVerifies(level) && policy.check.length === 0) {
    observations.push(
      (movesTrunk
        ? 'This level lands only verified work, and the project declares no check commands, so every landing will hold for a person. '
        : 'This level verifies with the project’s checks, and none are declared, so nothing will be verified. ') +
        'A person can add them under Project Settings › Checks (`check` in project.json).'
    )
  }
  if (movesTrunk && !mayLand) {
    observations.push(
      'This task’s mandate does not include `land`, so the landing will hold however the policy reads. ' +
        'Authority is inherited and cannot be widened from inside a task.'
    )
  }
  if (level === 'commit-and-push' && !mayPush) {
    observations.push('This task’s mandate does not include `push`, so the push step will not run.')
  }
  if (policy.pushRemote && !policy.upstreamRemote) {
    observations.push(
      `\`${policy.pushRemote}\` is a push remote (the t897 fork layout): origin is someone else’s repository. ` +
        'Project Settings › Make my fork home makes the fork `origin` and the original `upstream`.'
    )
  }
  if (policy.upstreamRemote && !remotes.some((r) => r.name === policy.upstreamRemote) && remotes.length > 0) {
    observations.push(`project.json names \`${policy.upstreamRemote}\` as upstream, but no remote by that name exists.`)
  }
  // ⭐ t907: `fork` was read as *my fork* by the operator and as fine by the agent asked to check it.
  if (targetFound === false && !inTrunk) {
    observations.push(
      `The landing target \`${target}\` names no branch in this repository or on origin, so new task ` +
        'branches start from whatever the trunk checkout has checked out, and a landing onto it will be ' +
        'refused. It is a branch name, not a role: a person sets it under Project Settings › Landing target.'
    )
  }
  if (project.vcs === 'git' && remotes.length > 0 && !remotes.some((r) => r.name === 'origin')) {
    observations.push('There is no `origin` remote, so landings are measured against the local target only.')
  }
  if (!policyLands(level) && level !== 'report-only' && level !== 'custom') {
    observations.push(
      `At \`${level}\` nothing reaches \`${target}\` without a person. If this project should land on its own, ` +
        'Project Settings › Finish policy is where that is chosen (`landing.finish`).'
    )
  }
  if (finish.source === 'fleet') {
    observations.push('The finish policy is the fleet default; this project has not chosen one of its own.')
  }

  return {
    project: { name: project.name, vcs: project.vcs, root: project.root, config: project.configPath },
    task: { seq: task.seq, kind: task.kind },
    landing: {
      finish: { policy: finish.policy, label: finishLabel(finish.policy, target), source: finish.source, instruction: finish.instruction },
      landsWith: level,
      target,
      checks,
      postLanding: policy.postLanding,
      pushRemote: policy.pushRemote,
      upstreamRemote: policy.upstreamRemote,
      forkOnly: policy.forkOnly,
      whatHappens: whatHappens(level, target, checks, policy.pushRemote, policy.upstreamRemote, inTrunk, finish.instruction)
    },
    workspace: { mode: workspace.mode, source: workspace.source },
    completion: { mode: COMPLETION_LABELS[completion.mode], source: completion.source },
    sessionSharing: { sharing: SHARING_LABELS[sharing.sharing], source: sharing.source },
    quotaAutoResume: policy.quotaAutoResume,
    mandate: { allowed: [...allowed], mayLand, mayPush },
    remotes: remotes.map((r) => ({ ...r, role: role(r.name) })),
    observations,
    howToChange:
      'You cannot change any of these, and should not try to by editing project.json. If a setting looks ' +
      'wrong for this work, say which one, what you would set it to and why, in your reply or with ' +
      '`ask_human`. A person changes them in Warmstart: Project Settings (Finish policy, Landing target, ' +
      'Upstream, Checks, Post-landing, Completion mode, Default workspace, Session sharing), or for this ' +
      'task only, the finish/workspace pills on its thread. The committed file is `.warmstart/project.json`.'
  }
}

/** The RPC: session → open run → task → project, re-read from disk as the landing would. */
export async function readProjectBrief(sessionId: string): Promise<AgentProjectSettings | null> {
  const run = runForSession(sessionId)
  const task = run?.taskId ? getTask(run.taskId) : null
  if (!task?.projectId) return null
  // ⚠️ Fresh from disk, like the landing decision: a warm session can be hours past the last reload.
  const project = reloadProjectIfPresent(task.projectId)
  if (!project) return null
  const remotes = project.vcs === 'git' ? parseRemotes(await tryGit(project.root, ['remote', '-v'])) : []
  const targetFound = project.vcs === 'git' ? await landingTargetFound(project.root, landingTargetFor(task, project)) : null
  return projectBrief(task, project, remotes, targetFound)
}
