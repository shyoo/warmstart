import type { Api } from '../api.js'
import { pickApi } from './pick.js'

const methods = ['agent.complete', 'agent.awaitHuman', 'agent.createTask', 'agent.split', 'agent.depend', 'agent.handoff'] as const

export function apiAgent(api: Api) { return pickApi(api, methods) }
