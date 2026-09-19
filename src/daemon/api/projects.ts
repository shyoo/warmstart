/** Projects: registration, configuration, checks and the flow view. */
import { addProject, archiveProject, listProjects, relocateProject, reloadProject, reorderProjects, requireProject, setProjectChecks, setProjectPolicy, writeStarterConfig } from '../projects.js'
import { proposeChecks } from '../projectstack.js'
import { createProject, inspectProjectDirectory, proposeProjectDocs, workspaceRootReport } from '../projectsetup.js'
import { flowWorkspaces } from '../flow.js'
import { ensurePool, prunePoolWorktrees } from '../worktrees.js'
import { log } from '../log.js'
import type { Api, ApiContext } from './support.js'

type ProjectMethod =
  | 'project.list' | 'project.add' | 'project.relocate' | 'project.inspect' | 'project.workspaceRoot' | 'project.docTemplates'
  | 'project.create' | 'project.reload' | 'project.reorder' | 'project.archive' | 'project.writeConfig' | 'project.flow'
  | 'project.proposeChecks' | 'project.setChecks' | 'project.setPolicy' | 'project.pruneWorktrees'

export function apiProjects(_ctx: ApiContext): Pick<Api, ProjectMethod> {
  return {
    'project.list': () => listProjects(),
    'project.add': (p) => addProject(p),
    'project.relocate': (p) => relocateProject(p.id, p.root),
    'project.inspect': (p) => inspectProjectDirectory(p),
    'project.workspaceRoot': (p) => workspaceRootReport(p.root, p.workspaceRoot),
    'project.docTemplates': (p) => ({ docs: proposeProjectDocs(p) }),
    'project.create': (p) => createProject(p),
    'project.reload': (p) => reloadProject(p.id),
    'project.reorder': (p) => reorderProjects(p.ids),
    'project.archive': (p) => archiveProject(p.id),
    'project.writeConfig': (p) => ({ path: writeStarterConfig(p.id) }),
    // ⛔ Resolved here, never in the renderer — see the method's note in protocol.ts.
    'project.flow': (p) => flowWorkspaces(p.projectId),
    'project.proposeChecks': (p) => ({ checks: proposeChecks(requireProject(p.id).root) }),
    'project.setChecks': (p) => setProjectChecks(p.id, p.checks),
    /**
     * ⛔ **The pool follows the policy here, not on some later dispatch.** `poolSize` is only a
     * number in `project.json` until `ensurePool` turns it into worktrees and a Resource capacity,
     * and until 2026-09-01 nothing did that when the operator changed it — `ensurePool` was reachable
     * only from `claimWorkspace` and from the loose-ends scan an Overview load runs. So the width the
     * operator had just chosen was true in the file and false in the Resources panel, for as long as
     * it took something unrelated to happen.
     *
     * ⚠️ **Not the fix for the hold that came with it** — `poolPressure` is. A task filed against a
     * pool that was full at its old size used to be held by a gate reading the stale capacity, and
     * the hold blocked the very dispatch that would have corrected it; that loop was cut by reading
     * the *configured* size in the gate (t91, `9278841`). This is the other half: making the setting
     * true when it is made, rather than when it is next needed.
     *
     * ⚠️ Best-effort, and deliberately unable to fail the setting. The operator's choice is written
     * either way; if git cannot create the worktree the capacity simply stays where it was, the next
     * `claimWorkspace` tries again, and the error is in the log rather than in a dialog over a
     * settings form.
     *
     * ⚠️ Narrowing takes effect here too, because `ensurePool` rebuilds the member list from
     * `1..poolSize`. ⛔ Nothing on disk is removed — deleting a worktree can destroy work — and a
     * claim already held on a member that is no longer one stays valid until its run ends.
     */
    'project.setPolicy': async ({ id, ...patch }) => {
      const project = setProjectPolicy(id, patch)
      if (patch.poolSize !== undefined) {
        try {
          const members = await ensurePool(project)
          log.info(`${project.name}: workspace pool is now ${members.length} member(s)`)
        } catch (err) {
          log.error(`could not resize the workspace pool for ${project.name}:`, err)
        }
      }
      return project
    },
    // ⛔ Local only — see `project.setPolicy`'s note and `remote/policy.ts`. Removing worktrees
    // from disk is the confirmed destructive half of going trunk-only; a phone never does it.
    'project.pruneWorktrees': async (p) => prunePoolWorktrees(requireProject(p.id)),
  }
}
