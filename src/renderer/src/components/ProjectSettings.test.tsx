import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PoolStorageReport, Project } from '@shared/tasks'
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
    expect(html).toContain('Shared dependency store')
    expect(html).toContain('Copy-on-write slot cloning')
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
    expect(html).not.toContain('Shared dependency store')
    expect(html).not.toContain('Copy-on-write slot cloning')

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

describe('ProjectSettings pool storage, CoW, and dependency store', () => {
  const now = Date.now()
  const baseStorage: PoolStorageReport = {
    members: [
      {
        path: 'C:/dev/demo_workspaces/ws1',
        bytes: 53 * 1024 * 1024,
        measuredAt: now - 3 * 60_000
      }
    ],
    cow: {
      supported: false,
      filesystem: 'NTFS',
      mechanism: 'none',
      reason: 'this volume cannot clone; slots are full copies',
      measuredAt: now - 2 * 60_000,
      probedPath: 'C:/dev/demo_workspaces'
    },
    dependencyStore: {
      configured: false,
      mode: null,
      storeDir: null,
      bytes: null,
      measuredAt: now,
      reason: 'not configured'
    }
  }

  it('shows both storage controls for git and jj projects and renders poolStorage members', () => {
    for (const vcs of ['git', 'jj'] as const) {
      const html = renderToStaticMarkup(
        <ProjectSettings
          project={makeProject({ vcs })}
          resources={[]}
          refreshProjects={async () => undefined}
          initialPoolStorage={baseStorage}
        />
      )
      expect(html).toContain('Shared dependency store')
      expect(html).toContain('Copy-on-write slot cloning')
      expect(html).toContain('Re-probe')
      expect(html).toContain('ws1 · 53.0 MB · measured 3 min ago')
      expect(html).toContain('Not configured')
    }
  })

  it('shows unsupported NTFS CoW reason, age, and warning when CoW is enabled', () => {
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({
          vcs: 'git',
          config: {
            schema_version: 1,
            name: 'Demo',
            workspaces: { poolSize: 2, cow: { enabled: true } }
          }
        })}
        resources={[]}
        refreshProjects={async () => undefined}
        initialPoolStorage={baseStorage}
      />
    )

    expect(html).toContain('this volume cannot clone; slots are full copies · measured 2 min ago')
    expect(html).toContain('class="warn"')
    expect(html).toContain('Copy-on-write is enabled, but this volume cannot clone; slots are full copies.')
    expect(html).toContain('CoW seed paths')
    expect(html).toContain('placeholder="node_modules"')
  })

  it('shows ReFS (refs-block-clone) + age without unsupported warning and renders seed paths when supported and enabled', () => {
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({
          vcs: 'jj',
          config: {
            schema_version: 1,
            name: 'Demo',
            workspaces: {
              poolSize: 2,
              cow: { enabled: true, seedPaths: ['node_modules', '.next/cache'] }
            }
          }
        })}
        resources={[]}
        refreshProjects={async () => undefined}
        initialPoolStorage={{
          ...baseStorage,
          cow: {
            supported: true,
            filesystem: 'ReFS',
            mechanism: 'refs-block-clone',
            reason: 'ReFS block cloning supported',
            measuredAt: now - 4 * 60_000,
            probedPath: 'C:/dev/demo_workspaces'
          }
        }}
      />
    )

    expect(html).toContain('ReFS (refs-block-clone) · measured 4 min ago')
    expect(html).not.toContain('this volume cannot clone; slots are full copies')
    expect(html).not.toContain('Copy-on-write is enabled, but')
    expect(html).toContain('CoW seed paths')
    expect(html).toContain('value="node_modules, .next/cache"')
  })

  it('shows unpopulated dependency store as not populated yet (never 0 B) and populated store with bytes, age, and storeDir', () => {
    const unpopulatedHtml = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({
          config: {
            schema_version: 1,
            name: 'Demo',
            workspaces: { poolSize: 2, dependencyStore: { mode: 'pnpm' } }
          }
        })}
        resources={[]}
        refreshProjects={async () => undefined}
        initialPoolStorage={{
          ...baseStorage,
          dependencyStore: {
            configured: true,
            mode: 'pnpm',
            storeDir: 'C:/dev/demo_workspaces/.store/pnpm',
            bytes: null,
            measuredAt: now - 2 * 60_000,
            reason: 'not populated yet'
          }
        }}
      />
    )

    expect(unpopulatedHtml).toContain('pnpm store · not populated yet · measured 2 min ago')
    expect(unpopulatedHtml).not.toContain('0 B')
    expect(unpopulatedHtml).toContain('C:/dev/demo_workspaces/.store/pnpm')
    expect(unpopulatedHtml).toContain('Dependency install command')
    expect(unpopulatedHtml).toContain('Dependency lockfiles')

    const populatedHtml = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({
          config: {
            schema_version: 1,
            name: 'Demo',
            workspaces: {
              poolSize: 2,
              dependencyStore: {
                mode: 'npm-cache',
                lockfiles: ['package-lock.json']
              }
            }
          }
        })}
        resources={[]}
        refreshProjects={async () => undefined}
        initialPoolStorage={{
          ...baseStorage,
          dependencyStore: {
            configured: true,
            mode: 'npm-cache',
            storeDir: 'C:/dev/demo_workspaces/.store/npm-cache',
            bytes: 128 * 1024 * 1024,
            measuredAt: now - 5 * 60_000,
            reason: 'measured'
          }
        }}
      />
    )

    expect(populatedHtml).toContain('npm-cache store · 128.0 MB · measured 5 min ago')
    expect(populatedHtml).toContain('C:/dev/demo_workspaces/.store/npm-cache')
    expect(populatedHtml).toContain('value="package-lock.json"')
  })

  it('shows Hook install-command helper note when Hook mode is configured without a command yet', () => {
    const html = renderToStaticMarkup(
      <ProjectSettings
        project={makeProject({
          config: {
            schema_version: 1,
            name: 'Demo',
            workspaces: { poolSize: 2, dependencyStore: { mode: 'hook' } }
          }
        })}
        resources={[]}
        refreshProjects={async () => undefined}
        initialPoolStorage={baseStorage}
      />
    )

    expect(html).toContain('Enter an install command below and click Save to enable Hook mode.')
  })
})
