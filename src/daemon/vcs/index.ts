import type { Project } from '@shared/tasks.js'
import type { VcsDriver } from './driver.js'
import { gitDriver } from './git.js'
import { jjDriver } from './jj.js'

export type { VcsCapabilities, VcsDriver, VcsRebaseResult, VcsWorkspaceEntry } from './driver.js'
export { gitDriver } from './git.js'
export { jjConflicted, jjDriver } from './jj.js'

/** Resolve the VCS driver for `project`, or `null` when the project uses no version control (`vcs: 'none'`). */
export function driverFor(project: Pick<Project, 'vcs'>): VcsDriver | null {
  if (project.vcs === 'git') return gitDriver
  if (project.vcs === 'jj') return jjDriver
  return null
}
