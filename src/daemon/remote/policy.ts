import type { DaemonEvent, RpcMethod } from '@shared/protocol.js'

export type RemoteAccess = 'read' | 'write' | 'deny'

/**
 * The mobile allowlist. Raw PTY input (`session.write`), process control, worker and project
 * administration, settings, and the agent MCP surface remain desktop-only.
 */
export const REMOTE_METHODS = {
  'health': 'read',
  'adapter.list': 'deny',
  'adapter.detect': 'deny',
  'fleet.list': 'read',
  'worker.create': 'deny',
  'worker.update': 'deny',
  'worker.setCreditsIntent': 'deny',
  'worker.reorder': 'deny',
  'worker.retire': 'deny',
  'worker.probe': 'deny',
  'costmodel.list': 'deny',
  'model.options': 'read',
  'daemon.shutdown': 'deny',
  'doctor.run': 'deny',
  'session.list': 'deny',
  'session.spawn': 'deny',
  'session.write': 'deny',
  'session.resize': 'deny',
  'session.close': 'deny',
  'session.backscroll': 'deny',
  'project.list': 'read',
  'project.add': 'deny',
  'project.inspect': 'deny',
  'project.workspaceRoot': 'deny',
  'project.docTemplates': 'deny',
  'project.create': 'deny',
  'project.reload': 'deny',
  'project.archive': 'deny',
  'project.writeConfig': 'deny',
  'project.flow': 'deny',
  'task.list': 'read',
  'task.page': 'deny',
  'task.get': 'read',
  'review.eligibility': 'deny',
  'review.request': 'deny',
  'review.cancel': 'deny',
  'review.delete': 'deny',
  'review.manual.create': 'deny',
  'review.manual.delete': 'deny',
  'task.create': 'write',
  'attachment.create': 'deny',
  'attachment.folder': 'deny',
  'attachment.read': 'deny',
  'task.update': 'write',
  'task.message': 'write',
  'task.cancel': 'write',
  'task.resume': 'write',
  'task.pendingWork': 'read',
  'task.commitConversation': 'deny',
  'task.landConversation': 'deny',
  'task.overrideQuota': 'write',
  'task.resolve': 'write',
  'task.deleteCheck': 'read',
  'task.delete': 'deny',
  'task.restore': 'deny',
  'task.promote': 'write',
  'task.addDependency': 'deny',
  'task.removeDependency': 'deny',
  'project.proposeChecks': 'deny',
  'project.setChecks': 'deny',
  'project.setPolicy': 'deny',
  'approval.list': 'read',
  'approval.request': 'deny',
  'approval.answer': 'write',
  'approval.rules': 'deny',
  'question.ask': 'deny',
  'question.list': 'read',
  'question.forTask': 'read',
  'question.answer': 'write',
  'approval.addRule': 'deny',
  'approval.removeRule': 'deny',
  'resource.list': 'read',
  'cost.report': 'read',
  'routing.decisions': 'deny',
  'routing.velocity': 'deny',
  'routing.models': 'deny',
  'quality.report': 'deny',
  'statistics.report': 'deny',
  'quality.ungraded': 'deny',
  'quality.queue': 'deny',
  'quality.batch.start': 'deny',
  'quality.batch': 'deny',
  'quality.batch.cancel': 'deny',
  'task.setFinishPolicy': 'write',
  'task.setModel': 'write',
  'task.setWorker': 'write',
  'task.setPriority': 'write',
  'task.setSessionSharing': 'deny',
  'task.setAutoCompact': 'deny',
  'task.setStatsExcluded': 'deny',
  'task.setCompletionMode': 'write',
  'task.setObjective': 'write',
  'task.land': 'write',
  'task.resolveConflict': 'write',
  'task.resolveRetry': 'write',
  'task.resolveChecks': 'write',
  'task.resolveCommit': 'write',
  'conversation.list': 'read',
  'looseend.list': 'deny',
  'looseend.dismiss': 'deny',
  'looseend.reclaim': 'deny',
  'looseend.retire': 'deny',
  'log.tail': 'deny',
  'log.files': 'deny',
  'settings.get': 'deny',
  'settings.set': 'deny',
  'scheduler.tick': 'deny',
  'controller.report': 'deny',
  'controller.drain': 'deny',
  'task.plan': 'deny',
  'task.estimate': 'read',
  'chat.history': 'deny',
  'chat.send': 'deny',
  'chat.clear': 'deny',
  'agent.complete': 'deny',
  'agent.createTask': 'deny',
  'agent.handoff': 'deny',
  'agent.awaitHuman': 'deny',
  'agent.split': 'deny',
  'agent.depend': 'deny',
  'remote.status': 'deny',
  'remote.recheck': 'deny',
  'remote.setEnabled': 'deny',
  'remote.setBind': 'deny',
  'remote.setProject': 'deny',
  'remote.pairingCode': 'deny',
  'remote.revokeDevice': 'deny',
  // ⚠️ The three the phone itself needs. Everything else under `remote.` administers the feature
  // and stays on the desktop, where the operator can see who is paired.
  'remote.pushKey': 'read',
  'remote.subscribe': 'write',
  'remote.unsubscribe': 'write',
} as const satisfies Record<RpcMethod, RemoteAccess>

/**
 * The bearer token on an event-socket upgrade, from either place a client can put it.
 *
 * Browsers cannot set an `Authorization` header on a `WebSocket` handshake, so the phone app
 * passes `?token=` on `/remote/events` instead. The header stays first where both are present —
 * it is the one that never lands in a log line — and anything else on the URL is ignored.
 */
export function eventSocketToken(authorization: string | undefined, url: string | undefined): string | null {
  if (authorization?.startsWith('Bearer ')) return authorization.slice(7)
  if (!url) return null
  try {
    const token = new URL(url, 'http://localhost').searchParams.get('token')
    return token && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/**
 * Which project a call belongs to, and where in its params to find that out.
 *
 * ⛔ The per-project switch is the operator's second gate, and it is only worth anything if every
 * allowed method is answered *by name*. Guessing from a `task.` prefix looked equivalent and was
 * not: it read `id` off `question.forTask`, which carries `taskId` and nothing else, and it
 * demanded a `projectId` from `task.list`, whose parameter is optional — one method 404'd on every
 * call and the other took the fleet's whole task list with it (t310, 2026-09-08).
 *
 * - `fleet`     — no project dimension. Quota, models, the project list itself.
 * - `project`   — the params name a project. `required: false` means the call is legal without one
 *                 and the *result* is filtered to enabled projects instead (`REMOTE_FILTERED`).
 * - `task`      — the params name a task; its project decides.
 * - `question` / `approval` — the params name a question or approval, which is looked up to reach
 *                 its task. ⚠️ Answering is the whole point of this app, so these cannot be `fleet`.
 */
export type RemoteScope =
  | { by: 'fleet' }
  | { by: 'project'; param: string; required: boolean }
  | { by: 'task'; param: string }
  | { by: 'question'; param: string }
  | { by: 'approval'; param: string }

/** Every method the allowlist does not deny — the exact set `REMOTE_SCOPES` must cover. */
export type RemoteAllowedMethod = {
  [K in RpcMethod]: (typeof REMOTE_METHODS)[K] extends 'deny' ? never : K
}[RpcMethod]

const fleet = { by: 'fleet' } as const
const byId = { by: 'task', param: 'id' } as const

/**
 * ⛔ Exhaustive by construction: allowing a method in `REMOTE_METHODS` without saying which project
 * it belongs to fails this file's build by name, which is the only reason the two lists stay honest.
 */
export const REMOTE_SCOPES = {
  'health': fleet,
  'fleet.list': fleet,
  'model.options': fleet,
  'resource.list': fleet,
  'cost.report': fleet,
  'project.list': fleet,
  'remote.pushKey': fleet,
  'remote.subscribe': fleet,
  'remote.unsubscribe': fleet,
  // ⚠️ Filtered, not refused: the phone asks for "everything I may see" and the server answers with
  // exactly that. `approval.list` and `question.list` take no project at all, so they are filtered
  // on the way out rather than gated on the way in.
  'approval.list': fleet,
  'question.list': fleet,
  'task.list': { by: 'project', param: 'projectId', required: false },
  // ⚠️ `required`, unlike `task.list`: its rows do not carry a project, so there is nothing to
  // filter them by afterwards. A caller that cannot name an enabled project gets nothing.
  'conversation.list': { by: 'project', param: 'projectId', required: true },
  'task.create': { by: 'project', param: 'projectId', required: true },
  'question.forTask': { by: 'task', param: 'taskId' },
  'question.answer': { by: 'question', param: 'id' },
  'approval.answer': { by: 'approval', param: 'id' },
  'task.get': byId,
  'task.pendingWork': byId,
  'task.deleteCheck': byId,
  'task.estimate': byId,
  'task.update': byId,
  'task.message': byId,
  'task.cancel': byId,
  'task.resume': byId,
  'task.overrideQuota': byId,
  'task.resolve': byId,
  'task.promote': byId,
  'task.setFinishPolicy': byId,
  'task.setModel': byId,
  'task.setWorker': byId,
  'task.setPriority': byId,
  'task.setCompletionMode': byId,
  'task.setObjective': byId,
  'task.land': byId,
  'task.resolveConflict': byId,
  'task.resolveRetry': byId,
  'task.resolveChecks': byId,
  'task.resolveCommit': byId
} as const satisfies Record<RemoteAllowedMethod, RemoteScope>

export function remoteScopeOf(method: RemoteAllowedMethod): RemoteScope {
  return REMOTE_SCOPES[method]
}

/**
 * Results that must be cut down to the enabled projects before they leave.
 *
 * Each names the field holding a task id, because a task is what carries a project. `task.list` is
 * the exception that carries `projectId` on the row itself.
 */
export const REMOTE_FILTERED = {
  'project.list': 'id',
  'approval.list': 'taskId',
  'question.list': 'taskId'
} as const

export const REMOTE_EVENT_CLASS = {
  'worker.changed': 'fleet', 'project.changed': 'never', 'resource.changed': 'fleet', 'task.changed': 'task',
  'run.changed': 'task', 'approval.opened': 'task', 'approval.answered': 'task', 'question.opened': 'task',
  'question.answered': 'task', 'question.parked': 'task', 'quota.changed': 'fleet', 'session.changed': 'fleet',
  'session.data': 'never', 'session.exit': 'never', 'turn': 'task', 'consult.changed': 'task', 'chat.message': 'never',
  'log': 'never', 'task.activity': 'task'
} as const satisfies Record<DaemonEvent['type'], 'fleet' | 'task' | 'never'>

export function remoteEventTaskId(event: DaemonEvent): string | null {
  switch (event.type) {
    case 'task.changed': return event.task.id
    case 'run.changed': return event.run.taskId
    case 'approval.opened': case 'approval.answered': return event.approval.taskId
    case 'question.opened': case 'question.answered': case 'question.parked': return event.question.taskId
    case 'task.activity': return event.taskId
    case 'consult.changed': return event.consult.subjectId
    default: return null
  }
}
