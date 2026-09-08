import type { Api } from '../api.js'
import { pickApi } from './pick.js'

const methods = [
  'project.list', 'project.add', 'project.inspect', 'project.workspaceRoot', 'project.docTemplates',
  'project.create', 'project.reload', 'project.archive', 'project.writeConfig', 'project.flow',
  'project.proposeChecks', 'project.setChecks', 'project.setPolicy'
] as const

export function apiProjects(api: Api) { return pickApi(api, methods) }
