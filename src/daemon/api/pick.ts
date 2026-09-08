import type { RpcMethod } from '@shared/protocol.js'
import type { Api } from '../api.js'

/** Keep each domain's exact RPC set visible and preserve the mapped API completeness check. */
export function pickApi<M extends RpcMethod>(api: Api, methods: readonly M[]): Pick<Api, M> {
  return Object.fromEntries(methods.map((method) => [method, api[method]])) as Pick<Api, M>
}
