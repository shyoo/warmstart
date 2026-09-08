import type { Api } from '../api.js'
import { pickApi } from './pick.js'

const methods = [
  'review.eligibility', 'review.request', 'review.cancel', 'review.delete', 'cost.report', 'routing.decisions',
  'routing.velocity', 'routing.models', 'quality.report', 'statistics.report', 'quality.ungraded', 'quality.queue',
  'quality.batch.start', 'quality.batch', 'quality.batch.cancel', 'scheduler.tick', 'controller.report',
  'controller.drain', 'task.plan', 'task.estimate', 'chat.history', 'chat.send', 'chat.clear'
] as const

export function apiQuality(api: Api) { return pickApi(api, methods) }
