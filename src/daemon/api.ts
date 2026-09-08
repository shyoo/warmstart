/**
 * The typed RPC table, assembled from the five domains that own its methods.
 *
 * ⛔ **The mapped type is the completeness check.** `Api` is `{ [M in RpcMethod]: Handler<M> }`,
 * so `satisfies Api` below fails by *name* on any method no domain claims - which is what caught
 * every handler while the table was one 118-entry literal, and what has to keep catching them now
 * that it is five files. A method belongs to exactly one domain: adding one means adding it to that
 * domain's file and nowhere else.
 */
import type { Api, ApiContext } from './api/support.js'
import { apiAgent } from './api/agent.js'
import { apiProjects } from './api/projects.js'
import { apiQuality } from './api/quality.js'
import { apiTasks } from './api/tasks.js'
import { apiWorkers } from './api/workers.js'

export type { Api, ApiContext, Handler } from './api/support.js'
export { checkConstraints, checkWorkerDefaults, modelReport } from './api/support.js'

export function buildApi(ctx: ApiContext): Api {
  return {
    ...apiWorkers(ctx),
    ...apiProjects(ctx),
    ...apiTasks(ctx),
    ...apiQuality(ctx),
    ...apiAgent(ctx)
  } satisfies Api
}
