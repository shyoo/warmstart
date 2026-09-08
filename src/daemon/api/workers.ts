import type { Api } from '../api.js'
import { pickApi } from './pick.js'

const methods = [
  'health', 'adapter.list', 'adapter.detect', 'fleet.list', 'worker.create', 'worker.update',
  'worker.setCreditsIntent', 'worker.reorder', 'worker.retire', 'worker.probe', 'costmodel.list',
  'model.options', 'daemon.shutdown', 'doctor.run', 'session.list', 'session.spawn', 'session.write',
  'session.resize', 'session.close', 'session.backscroll', 'settings.get', 'settings.set', 'log.tail', 'log.files'
] as const

export function apiWorkers(api: Api) { return pickApi(api, methods) }
