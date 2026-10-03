/**
 * **Propose upstream…** — the one way Warmstart opens a pull request on a repository the operator
 * forked from (t903).
 *
 * ⛔ **On a person's click, and on exactly what they were shown.** t902 opened a pull request on
 * `Optiscaler-Client/Optiscaler-Client` because its finish policy said to, and nobody had been asked.
 * Here the preview is read first, and the request that opens the PR carries the base and the commit
 * list the person saw; both are read again before anything is sent, and a difference is a refusal.
 *
 * ⛔ **Only this task's commits, replayed onto the upstream** — the operator's decision of
 * 2026-10-03. When the fork is home its trunk carries the operator's own files (an `AGENTS.md`, a
 * `HANDOFF.md`) that the upstream never asked for, and a branch cut from that trunk would carry them
 * into the pull request. So the branch is cut from `upstream/<target>` and the task's commits are
 * cherry-picked onto it, in a scratch worktree that is removed afterwards. A commit that does not
 * apply stops the whole proposal before anything is pushed.
 *
 * ⚠️ The pushed branch is `warmstart/up-t<seq>` on the fork, which is the operator's own repository;
 * re-proposing replaces it (`--force-with-lease`), which updates the pull request already open.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project, Task, UpstreamProposal, UpstreamProposalCommit, UpstreamProposeRequest } from '@shared/tasks.js'
import { gitHubSlug, parseGitHubRepo } from '@shared/github.js'
import { errorMessage } from '@shared/errors.js'
import { git, remoteUrl, tryGit } from './git.js'
import { landingTargetFor, policyFor, requireProject } from './projects.js'
import { addMessage, requireTask } from './tasks.js'
import { taskCommitShas } from './taskcommits.js'
import { pullRequestUrlIn } from './deliveries.js'
import { launchArgs, spawnEnv, which } from './which.js'
import * as repotrust from './repotrust.js'
import * as spawn from './spawn.js'
import { log } from './log.js'

interface Context {
  task: Task
  project: Project
  remote: string
  upstream: string
  forkOwner: string
  target: string
}

async function contextFor(taskId: string): Promise<Context> {
  const task = requireTask(taskId)
  if (!task.projectId) throw new Error('this task belongs to no project')
  const project = requireProject(task.projectId)
  const remote = policyFor(project).upstreamRemote
  if (!remote) {
    throw new Error(
      'this project names no upstream. Propose upstream works once your fork is home — ' +
        'Project settings → Make my fork home.'
    )
  }
  const upstreamUrl = await remoteUrl(project.root, remote)
  const originUrl = await remoteUrl(project.root, 'origin')
  const upstream = upstreamUrl ? parseGitHubRepo(upstreamUrl) : null
  const fork = originUrl ? parseGitHubRepo(originUrl) : null
  if (!upstream || !fork) {
    throw new Error(
      `a proposal needs \`${remote}\` and origin on github.com (${remote}: ${upstreamUrl ?? 'missing'}; ` +
        `origin: ${originUrl ?? 'missing'})`
    )
  }
  return { task, project, remote, upstream: gitHubSlug(upstream), forkOwner: fork.owner, target: landingTargetFor(task, project) }
}

/**
 * The commits that are this task's own, oldest first.
 *
 * ⚠️ The branch first, while it still has commits nothing else has; the commits the landing recorded
 * (`task_commits`) once it has landed and been retired. Either way, anything already on the upstream
 * is left out — it has nothing to propose.
 */
async function ownCommits(ctx: Context, baseSha: string): Promise<string[]> {
  const root = ctx.project.root
  let shas: string[] = []
  if (ctx.task.branch && (await tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ctx.task.branch}`]))) {
    const not: string[] = []
    for (const ref of [ctx.target, `origin/${ctx.target}`]) {
      if (await tryGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) not.push(ref)
    }
    const listed = await git(root, ['rev-list', '--reverse', '--no-merges', ctx.task.branch, '--not', baseSha, ...not])
    shas = listed.split('\n').map((l) => l.trim()).filter(Boolean)
  }
  if (shas.length === 0) {
    const recorded = taskCommitShas(ctx.task.id)
    const present: string[] = []
    for (const sha of recorded) {
      // ⚠️ `cat-file -e` prints nothing, so its yes is `''` — compare with null, not truthiness.
      if ((await tryGit(root, ['cat-file', '-e', `${sha}^{commit}`])) !== null) present.push(sha)
    }
    if (present.length > 0) {
      const ordered = await git(root, ['rev-list', '--no-walk=sorted', '--reverse', ...present])
      shas = ordered.split('\n').map((l) => l.trim()).filter(Boolean)
    }
  }
  const out: string[] = []
  for (const sha of shas) {
    // `merge-base --is-ancestor` exits 1 for "no", which `tryGit` reads as null.
    if ((await tryGit(root, ['merge-base', '--is-ancestor', sha, baseSha])) === null) out.push(sha)
  }
  return out
}

async function describe(root: string, sha: string): Promise<UpstreamProposalCommit> {
  const subject = (await git(root, ['log', '-1', '--format=%s', sha])).trim()
  const files = (await git(root, ['show', '--name-only', '--format=', sha])).split('\n').map((l) => l.trim()).filter(Boolean)
  return { sha, subject, files }
}

/** ⛔ Never the task's own title or prompt — those were written for this operator alone (t847). */
function suggestTitleAndBody(commits: UpstreamProposalCommit[]): { title: string; body: string } {
  const title = commits.length === 1 ? commits[0]!.subject : commits[commits.length - 1]!.subject
  const body = commits.length === 1 ? '' : commits.map((c) => `- ${c.subject}`).join('\n')
  return { title, body }
}

async function readProposal(ctx: Context): Promise<UpstreamProposal> {
  const root = ctx.project.root
  await git(root, ['fetch', ctx.remote, '--prune'])
  const baseRef = `refs/remotes/${ctx.remote}/${ctx.target}`
  const baseSha = await tryGit(root, ['rev-parse', '--verify', '--quiet', baseRef])
  if (!baseSha) throw new Error(`\`${ctx.remote}/${ctx.target}\` does not exist, so there is nothing to propose onto`)
  const shas = await ownCommits(ctx, baseSha.trim())
  if (shas.length === 0) throw new Error(`t${ctx.task.seq} has no commits that \`${ctx.remote}/${ctx.target}\` does not already have`)
  const commits = await Promise.all(shas.map((sha) => describe(root, sha)))
  const branch = `warmstart/up-t${ctx.task.seq}`
  return {
    upstream: ctx.upstream,
    base: ctx.target,
    baseSha: baseSha.trim(),
    branch,
    head: `${ctx.forkOwner}:${branch}`,
    commits,
    ...suggestTitleAndBody(commits),
    trust: await repotrust.repoTrust(ctx.upstream)
  }
}

/** What **Propose upstream…** would send. Reads; sends nothing. */
export async function previewUpstreamProposal(taskId: string): Promise<UpstreamProposal> {
  return readProposal(await contextFor(taskId))
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((sha, i) => sha === b[i])
}

/** Open the pull request the person was shown. See the file's note. */
export async function proposeUpstream(request: UpstreamProposeRequest): Promise<{ url: string }> {
  const title = request.title.trim()
  if (!title) throw new Error('a pull request needs a title')
  const ctx = await contextFor(request.id)
  const now = await readProposal(ctx)
  // ⛔ The consent was given for what was on the screen. Anything else is a new question.
  if (now.baseSha !== request.baseSha || !sameList(now.commits.map((c) => c.sha), request.commits)) {
    throw new Error(
      `what would be sent changed since you looked (\`${ctx.remote}/${ctx.target}\` or this task's commits ` +
        'moved). Nothing was sent; open the preview again.'
    )
  }
  const gh = which('gh')
  if (!gh) throw new Error('the GitHub CLI (gh) is not on PATH')

  const root = ctx.project.root
  const scratch = mkdtempSync(join(tmpdir(), `warmstart-up-t${ctx.task.seq}-`))
  let added = false
  try {
    await git(root, ['worktree', 'add', '--detach', scratch, now.baseSha])
    added = true
    for (const sha of request.commits) {
      try {
        await git(scratch, ['cherry-pick', '--allow-empty', sha])
      } catch (err) {
        await tryGit(scratch, ['cherry-pick', '--abort'])
        throw new Error(
          `\`${sha.slice(0, 8)}\` does not apply onto \`${ctx.remote}/${ctx.target}\` (${errorMessage(err)}). ` +
            'Nothing was sent.',
          { cause: err }
        )
      }
    }
    await tryGit(root, ['fetch', 'origin', `+refs/heads/${now.branch}:refs/remotes/origin/${now.branch}`])
    try {
      await git(scratch, ['push', 'origin', `HEAD:refs/heads/${now.branch}`])
    } catch (err) {
      if (!/rejected|non-fast-forward|fetch first/i.test(errorMessage(err))) throw err
      // ⚠️ Our own branch on the operator's own fork, re-proposed: replacing it is the update.
      await git(scratch, ['push', '--force-with-lease', 'origin', `HEAD:refs/heads/${now.branch}`])
    }
  } finally {
    if (added) await tryGit(root, ['worktree', 'remove', '--force', scratch])
    rmSync(scratch, { recursive: true, force: true })
  }

  const run = async (args: string[]): Promise<string> => {
    const call = launchArgs(gh, args)
    const { stdout } = await spawn.run(call.command, call.args, {
      cwd: root,
      env: spawnEnv(),
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000
    })
    return stdout
  }
  let url: string | undefined
  try {
    url = pullRequestUrlIn(
      await run(['pr', 'create', '--repo', ctx.upstream, '--base', ctx.target, '--head', now.head, '--title', title, '--body', request.body])
    )
  } catch (err) {
    if (!/already exists/i.test(errorMessage(err))) throw err
    url = pullRequestUrlIn(errorMessage(err))
  }
  if (!url) url = pullRequestUrlIn(await run(['pr', 'view', now.head, '--repo', ctx.upstream, '--json', 'url', '--jq', '.url']))
  if (!url) throw new Error('GitHub did not report the pull request URL')

  log.info(`t${ctx.task.seq}: proposed upstream on the operator's click: ${url}`)
  // ⛔ Deliberately not *Pull request opened for …* and not `landing.landed`: nothing landed on this
  // project's target, and `deliveries.ts` reconciles PRs by that prefix as this project's own.
  addMessage(ctx.task.id, 'system', `Proposed upstream, on your click: ${url}`, null, [], {
    detail:
      `${request.commits.length} commit${request.commits.length === 1 ? '' : 's'} replayed onto ` +
      `\`${ctx.remote}/${ctx.target}\` (${now.baseSha.slice(0, 8)}) and pushed to your fork as ` +
      `\`${now.branch}\`; the pull request is on ${ctx.upstream} from \`${now.head}\`.`
  })
  return { url }
}
