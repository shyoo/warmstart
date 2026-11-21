import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project } from '@shared/tasks'
import type { VcsMigrationResult } from '@shared/protocol'
import { ProjectSettings } from './ProjectSettings'
import {
  formatMigrationSummary,
  migrationTargetVcs,
  VcsMigrationModal
} from './VcsMigrationModal'

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Demo',
    root: 'C:/dev/demo',
    vcs: 'jj',
    config: {
      schema_version: 1,
      name: 'Demo',
      landing: { finish: 'commit-and-merge', target: 'main' },
      workspaces: { poolSize: 3, mode: 'worktree' }
    },
    configPath: 'C:/dev/demo/.warmstart/project.json',
    createdAt: 1,
    archivedAt: null,
    rootExists: true,
    ...overrides
  }
}

describe('ProjectSettings VCS capability gating', () => {
  it('supports branching, pool controls, and Change version control… for colocated jj projects', () => {
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({ vcs: 'jj' })}
        resources={[]}
        refreshProjects={async () => undefined}
      />
    )

    expect(html).toContain('>jj<')
    expect(html).toContain('Change version control…')
    expect(html).toContain('Default workspace')
    expect(html).toContain('Prune on release')
    expect(html).toContain('The branch or bookmark new tasks start from and land onto')
    expect(html).not.toContain('this project has no repository')

    const poolInputMatch = html.match(/<input[^>]*aria-label="Workspace pool size"[^>]*>/)
    expect(poolInputMatch?.[0]).toBeTruthy()
    expect(poolInputMatch?.[0]).not.toContain('disabled')

    const topologyBtnMatch = html.match(/<button[^>]*aria-label="Workspace topology"[^>]*>/)
    expect(topologyBtnMatch?.[0]).toBeTruthy()
    expect(topologyBtnMatch?.[0]).not.toContain('disabled')
  })

  it('omits Change version control… and keeps topology and pool disabled for vcs=none', () => {
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({ vcs: 'none', config: { schema_version: 1 } })}
        resources={[]}
        refreshProjects={async () => undefined}
      />
    )

    expect(html).toContain('>none<')
    expect(html).not.toContain('Change version control…')
    expect(html).toContain('this project has no repository')
    expect(html).not.toContain('Default workspace')
    expect(html).not.toContain('Prune on release')

    const poolInputMatch = html.match(/<input[^>]*aria-label="Workspace pool size"[^>]*>/)
    expect(poolInputMatch?.[0]).toContain('disabled=""')

    const topologyBtnMatch = html.match(/<button[^>]*aria-label="Workspace topology"[^>]*>/)
    expect(topologyBtnMatch?.[0]).toBeTruthy()
    expect(topologyBtnMatch?.[0]).toContain('disabled=""')
  })
})

describe('VcsMigrationModal and migration helpers', () => {
  it('maps each VCS to its local migration target', () => {
    expect(migrationTargetVcs('git')).toBe('jj')
    expect(migrationTargetVcs('jj')).toBe('git')
    expect(migrationTargetVcs('none')).toBeNull()
  })

  it('renders git -> jj options with allowDirtyTrunk unchecked and no removeJjDir toggle', () => {
    const html = renderToStaticMarkup(
      <VcsMigrationModal
        project={makeProject({ vcs: 'git' })}
        onClose={() => undefined}
        onMigrated={() => undefined}
      />
    )

    expect(html).toContain('Change version control to colocated jj')
    expect(html).toContain('jj git init --colocate')
    expect(html).toContain('Allow uncommitted changes in the trunk')
    expect(html).not.toContain('checked=""')
    expect(html).not.toContain('Remove .jj directory after switching to git')
  })

  it('renders jj -> git options with both allowDirtyTrunk and removeJjDir unchecked', () => {
    const html = renderToStaticMarkup(
      <VcsMigrationModal
        project={makeProject({ vcs: 'jj' })}
        onClose={() => undefined}
        onMigrated={() => undefined}
      />
    )

    expect(html).toContain('Change version control back to git')
    expect(html).toContain('Allow uncommitted changes in the trunk')
    expect(html).toContain('Remove .jj directory after switching to git')
    expect(html).not.toContain('checked=""')
  })

  it('formats migration summaries with workspace counts, .jj status, and verbatim warnings', () => {
    const keptResult: VcsMigrationResult = {
      project: makeProject({ vcs: 'git' }),
      migration: {
        id: 'm1',
        projectId: 'proj-1',
        fromVcs: 'jj',
        toVcs: 'git',
        status: 'completed',
        startedAt: 1,
        finishedAt: 2,
        detail: {}
      },
      warnings: ['Skipped dirty slot ws2.', 'Bookmark foo was behind origin/foo.'],
      rebuiltWorkspaces: 2,
      keptJjDir: true
    }

    expect(formatMigrationSummary(keptResult)).toBe(
      'Switched Demo to git; rebuilt 2 pool workspace(s); .jj kept. Skipped dirty slot ws2. Bookmark foo was behind origin/foo.'
    )

    const removedResult: VcsMigrationResult = {
      ...keptResult,
      keptJjDir: false,
      warnings: []
    }

    expect(formatMigrationSummary(removedResult)).toBe(
      'Switched Demo to git; rebuilt 2 pool workspace(s); .jj removed.'
    )

    const forwardResult: VcsMigrationResult = {
      ...keptResult,
      project: makeProject({ vcs: 'jj' }),
      migration: {
        ...keptResult.migration,
        fromVcs: 'git',
        toVcs: 'jj'
      },
      warnings: []
    }

    expect(formatMigrationSummary(forwardResult)).toBe(
      'Switched Demo to jj; rebuilt 2 pool workspace(s).'
    )
  })
})
