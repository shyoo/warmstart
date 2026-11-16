import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { TaskDiffSummary } from '@shared/tasks'
import { DiffPaneContext } from '../../lib/diffpane'
import { artifactsOf, DiffPanel, TaskArtifacts } from './DiffPanel'

function summaryWith(overrides: Partial<TaskDiffSummary> = {}): TaskDiffSummary {
  return {
    ok: true,
    reason: '',
    base: 'main',
    head: 'warmstart/t1393-plan',
    from: 'branch',
    separateCommits: 0,
    files: [
      {
        path: 'transient_docs/t1393-jj-vcs-and-disk-plan_2026-11-15.md',
        added: 198,
        removed: 0,
        binary: false,
        generated: false
      },
      { path: 'src/daemon/index.ts', added: 4, removed: 1, binary: false, generated: false }
    ],
    insertions: 202,
    deletions: 1,
    filesTruncated: false,
    uncommittedFiles: 0,
    unlandedCommits: 1,
    workspaceReadable: true,
    ...overrides
  }
}

describe('markdown artifact collection and visibility', () => {
  it('collects committed and uncommitted markdown documents without dropping either', () => {
    const summary = summaryWith({
      uncommittedArtifacts: [
        'transient_docs/t1393-jj-vcs-and-disk-plan_2026-11-15.md',
        'transient_docs/follow-up-notes.md'
      ]
    })

    expect(artifactsOf(summary)).toEqual([
      {
        path: 'transient_docs/t1393-jj-vcs-and-disk-plan_2026-11-15.md',
        added: 198,
        removed: 0,
        uncommitted: true
      },
      {
        path: 'transient_docs/follow-up-notes.md',
        uncommitted: true
      }
    ])
  })

  it('keeps uncommitted markdown files visible even before a branch has its first commit', () => {
    const summary = summaryWith({
      ok: false,
      reason: 'this branch has no commits yet',
      files: [],
      insertions: 0,
      deletions: 0,
      uncommittedFiles: 1,
      unlandedCommits: 0,
      uncommittedArtifacts: ['transient_docs/draft-plan.md']
    })

    expect(artifactsOf(summary)).toEqual([
      { path: 'transient_docs/draft-plan.md', uncommitted: true }
    ])
  })

  it('renders TaskArtifacts outside any <details> disclosure and distinguishes uncommitted chips', () => {
    const html = renderToStaticMarkup(
      <DiffPaneContext.Provider value={{ request: null, open: () => undefined, close: () => undefined }}>
        <TaskArtifacts
          taskId="task-1"
          artifacts={artifactsOf(
            summaryWith({
              uncommittedArtifacts: ['transient_docs/uncommitted-notes.md']
            })
          )}
        />
      </DiffPaneContext.Provider>
    )

    expect(html).not.toContain('<details')
    expect(html).toContain('Artifacts (2)')
    expect(html).toContain('transient_docs/t1393-jj-vcs-and-disk-plan_2026-11-15.md')
    expect(html).toContain('transient_docs/uncommitted-notes.md')
    expect(html).toContain('uncommitted')
  })

  it('keeps DiffPanel collapsed by default at the gate and omits duplicate artifacts when hidden', () => {
    const summary = summaryWith()
    const html = renderToStaticMarkup(
      <DiffPanel
        taskId="task-1"
        updatedAt={1}
        atGate
        summaryState={{ summary, error: null }}
        hideArtifacts
      />
    )

    expect(html).toContain('<details class="diff-panel">')
    expect(html).not.toContain('<details class="diff-panel" open')
    expect(html).not.toContain('diff-panel-artifacts')
  })
})

describe('TaskThread artifact and diff surface placement (source level)', () => {
  const thread = readFileSync(new URL('../TaskThread.tsx', import.meta.url), 'utf8')

  it('renders TaskArtifacts above DiffPanel inside the right status pane, not in detail-main', () => {
    const sideStart = thread.indexOf('<aside className="detail-side" hidden={side !== \'status\'}>')
    const sideEnd = thread.indexOf('</aside>', sideStart)
    const artifactsPos = thread.indexOf('<TaskArtifacts ')
    const diffPanelPos = thread.indexOf('<DiffPanel')
    expect(sideStart).toBeGreaterThan(-1)
    expect(sideEnd).toBeGreaterThan(sideStart)
    expect(artifactsPos).toBeGreaterThan(sideStart)
    expect(artifactsPos).toBeLessThan(sideEnd)
    expect(diffPanelPos).toBeGreaterThan(artifactsPos)
    expect(diffPanelPos).toBeLessThan(sideEnd)
    expect(thread.indexOf('<TaskArtifacts ', sideEnd)).toBe(-1)
    expect(thread.indexOf('<DiffPanel', sideEnd)).toBe(-1)
    expect(thread).toContain('hideArtifacts')
  })
})
