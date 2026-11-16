import type { Project } from '@shared/tasks.js'
import type { VcsDriver } from './driver.js'
import { gitDriver } from './git.js'

export type { VcsCapabilities, VcsDriver, VcsWorkspaceEntry } from './driver.js'
export { gitDriver } from './git.js'

/** Resolve the VCS driver for `project`, or `null` when the project uses no supported VCS driver yet. */
export function driverFor(project: Pick<Project, 'vcs'>): VcsDriver | null {
  if (project.vcs === 'git') return gitDriver
  return null
}
