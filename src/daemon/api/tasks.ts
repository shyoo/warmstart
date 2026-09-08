import type { Api } from '../api.js'
import { pickApi } from './pick.js'

const methods = [
  'task.list', 'task.page', 'task.get', 'task.create', 'attachment.create', 'attachment.folder', 'attachment.read',
  'task.update', 'task.setFinishPolicy', 'task.pendingWork', 'task.commitConversation', 'task.landConversation',
  'task.setSessionSharing', 'task.setCompletionMode', 'task.setAutoCompact', 'task.setStatsExcluded', 'task.setObjective',
  'task.setModel', 'task.setWorker', 'task.setPriority', 'task.land', 'task.resolveConflict', 'task.resolveRetry',
  'task.resolveChecks', 'task.resolveCommit', 'task.message', 'task.cancel', 'task.resume', 'task.overrideQuota',
  'task.resolve', 'task.deleteCheck', 'task.delete', 'task.restore', 'task.promote', 'task.addDependency',
  'task.removeDependency', 'approval.list', 'approval.request', 'approval.answer', 'approval.rules', 'approval.addRule',
  'approval.removeRule', 'question.ask', 'question.list', 'question.forTask', 'question.answer', 'resource.list',
  'conversation.list', 'looseend.list', 'looseend.retire', 'looseend.dismiss', 'looseend.reclaim'
] as const

export function apiTasks(api: Api) { return pickApi(api, methods) }
