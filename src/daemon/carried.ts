import type { Task } from '@shared/tasks.js'
import { branchContentLanded, commitsOnlyOn, type TaskBranch } from './worktrees.js'

/**
 * What the loose-ends panel does with a finished task's branch that the trunk does not hold (t1041).
 *
 * ⛔ **The trunk is not the only thing keeping work alive.** Measured 2026-10-10 on muturn: five *not
 * landed* rows (t1013, t1021, t1027, t1028, t1034) were pieces filed by conversation t1007, which
 * merges each finished piece into its own branch `warmstart/t1007.3-…`. Four of them had every commit
 * reachable from that branch — deleting them would have lost nothing — and the fifth carried one commit
 * its parent, still open, had not merged yet. All five read as stranded work because `commitsOnlyOn`
 * compared against `main` and `origin/main` alone.
 *
 * The verdicts, each an operator decision (t1041, 2026-10-10):
 *
 * - `parent-open` — a finished child of a task that is still open. Merging it is the parent's job, so
 *   it is hidden until the parent closes; if the parent closes without taking it, it reads as
 *   *not landed* again.
 * - `carried` — every unlanded commit is on (or, by the t948 proofs, content-equivalent to) the branch
 *   of a task that is still open. Hidden: when that branch closes it reports the work itself, once.
 * - `folded` — every unlanded commit is also on another finished branch's row (`into`). One row for
 *   the outermost branch instead of one per link of a chain.
 * - `own` — a row, counting only what no open branch carries, and naming the branches folded into it.
 *
 * ⚠️ **The panel only.** The sweep (`branchsweep.ts`) and **Retire it** still delete a name on trunk
 * proof alone: an open branch may yet be rebased or reset, and the child's name is then the backup.
 * ⚠️ Conservative where git cannot answer: a measurement that throws leaves the branch `own` at its
 * trunk-only count, which is exactly the row it drew before this existed.
 */
export type BranchVerdict =
  | { kind: 'parent-open'; parentSeq: number }
  | { kind: 'carried' }
  | { kind: 'folded'; into: string[] }
  | { kind: 'own'; count: number; carries: TaskBranch[] }

const CLOSED: ReadonlySet<Task['status']> = new Set<Task['status']>(['completed', 'failed', 'cancelled'])

/** Past this many candidates the pairwise fold is skipped: rows stay one per branch, as before. */
const FOLD_LIMIT = 40

export function taskIsOpen(task: Pick<Task, 'status' | 'deletedAt'>): boolean {
  return task.deletedAt === null && !CLOSED.has(task.status)
}

/**
 * A verdict for every finished task's branch that reads unlanded against the trunk.
 *
 * `tasks` is every live task of the project, keyed by `seq`. Branches outside the candidates — open
 * tasks', empty ones, content-landed ones, unmeasurable ones — get no verdict and keep today's row.
 */
export async function branchVerdicts(
  root: string,
  target: string,
  branches: readonly TaskBranch[],
  tasks: ReadonlyMap<number, Task>
): Promise<Map<string, BranchVerdict>> {
  const verdicts = new Map<string, BranchVerdict>()
  const byId = new Map([...tasks.values()].map((task) => [task.id, task]))
  // ⭐ Every branch of an open task — a conversation that re-lands owns several (`t1007.2`, `t1007.3`).
  const openRefs = branches
    .filter((b) => {
      const task = b.taskSeq === null ? undefined : tasks.get(b.taskSeq)
      return task !== undefined && taskIsOpen(task)
    })
    .map((b) => `refs/heads/${b.branch}`)

  const candidates: Array<{ branch: TaskBranch; count: number }> = []
  for (const branch of branches) {
    const task = branch.taskSeq === null ? undefined : tasks.get(branch.taskSeq)
    if (!task || taskIsOpen(task) || branch.ahead <= 0 || branch.contentLanded) continue
    const parent = task.parentTaskId ? byId.get(task.parentTaskId) : undefined
    if (parent && taskIsOpen(parent)) {
      verdicts.set(branch.branch, { kind: 'parent-open', parentSeq: parent.seq })
      continue
    }
    let count = branch.ahead
    if (openRefs.length > 0) {
      try {
        count = await commitsOnlyOn(root, branch.branch, target, openRefs)
      } catch {
        count = branch.ahead
      }
      if (count === 0 || (await branchContentLanded(root, branch.branch, target, openRefs).catch(() => false))) {
        verdicts.set(branch.branch, { kind: 'carried' })
        continue
      }
    }
    candidates.push({ branch, count })
  }

  // ⭐ Fold A into B when B holds every commit of A that the trunk and open branches lack. Two branches
  // holding the same set fold one way only — into the later name — so neither row can vanish into the
  // other. Containment is transitive, so the outermost row of a chain contains every link of it.
  const contains = new Map<string, Set<string>>()
  if (candidates.length > 1 && candidates.length <= FOLD_LIMIT) {
    for (const a of candidates) {
      for (const b of candidates) {
        if (a === b) continue
        let left: number
        try {
          left = await commitsOnlyOn(root, a.branch.branch, target, [...openRefs, `refs/heads/${b.branch.branch}`])
        } catch {
          continue
        }
        if (left === 0) {
          const inside = contains.get(b.branch.branch) ?? new Set<string>()
          inside.add(a.branch.branch)
          contains.set(b.branch.branch, inside)
        }
      }
    }
  }
  const within = (inner: string, outer: string): boolean => contains.get(outer)?.has(inner) ?? false
  const foldsInto = (a: string, b: string): boolean => within(a, b) && (!within(b, a) || a < b)
  const names = candidates.map((c) => c.branch.branch)
  for (const { branch, count } of candidates) {
    const into = names.filter((other) => other !== branch.branch && foldsInto(branch.branch, other))
    if (into.length > 0) {
      // ⚠️ Named by the outermost rows only, which are the ones the operator can actually see.
      const outer = into.filter((name) => !names.some((n) => n !== name && foldsInto(name, n)))
      verdicts.set(branch.branch, { kind: 'folded', into: outer.length > 0 ? outer : into })
      continue
    }
    const carries = candidates
      .filter((c) => c.branch.branch !== branch.branch && foldsInto(c.branch.branch, branch.branch))
      .map((c) => c.branch)
    verdicts.set(branch.branch, { kind: 'own', count, carries })
  }
  return verdicts
}

/** The clause a row appends for the finished branches folded into it, or `''`. */
export function carriesClause(carries: readonly TaskBranch[]): string {
  if (carries.length === 0) return ''
  const names = carries
    .map((b) => (b.taskSeq !== null ? `t${b.taskSeq}` : `\`${b.branch}\``))
    .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }))
  return ` — also carries ${names.join(', ')}`
}
