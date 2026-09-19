import { describe, expect, it } from 'vitest'
import type { ProjectInspection } from '@shared/tasks'
import {
  checksFromText,
  creationPlan,
  docSignature,
  EMPTY_DRAFT,
  stepBlockers,
  willHaveRepo,
  type NewProjectDraft
} from '../lib/newproject'

/**
 * The add-project wizard's rules.
 *
 * ⭐ Proved here rather than in `test:ui` for the reason `lib/` exists: the UI suite reads back what
 * rendered, so it can see that Next is disabled and not *why*. Every blocker below is a sentence an
 * operator is shown beside that button, and a disabled control with no stated reason is the failure
 * this whole module exists to prevent.
 */

function inspection(over: Partial<ProjectInspection> = {}): ProjectInspection {
  return {
    root: 'C:/dev/thing',
    exists: true,
    isDirectory: true,
    empty: false,
    vcs: 'git',
    alreadyAdded: null,
    suggestedName: 'thing',
    hasConfig: false,
    config: null,
    docs: { 'README.md': true, 'AGENTS.md': false, 'HANDOFF.md': false },
    stack: ['node'],
    proposedChecks: ['npm run test'],
    workspace: {
      path: 'C:/dev/thing_workspaces',
      state: 'free',
      takenBy: null,
      usable: true,
      note: null,
      relative: null
    },
    ...over
  }
}

function draft(over: Partial<NewProjectDraft> = {}): NewProjectDraft {
  return { ...EMPTY_DRAFT, root: 'C:/dev/thing', name: 'thing', ...over }
}

describe('leaving the directory step', () => {
  it('asks for a directory before anything else', () => {
    expect(stepBlockers('directory', draft({ root: '' }), null)).toEqual([
      'Choose the directory this project lives in.'
    ])
  })

  it('waits for the answer rather than letting somebody past an unchecked path', () => {
    expect(stepBlockers('directory', draft(), null)).toEqual(['Checking that directory…'])
  })

  it('passes a real repository', () => {
    expect(stepBlockers('directory', draft(), inspection())).toEqual([])
  })

  it('refuses a directory that is already a project, and names it', () => {
    const blockers = stepBlockers(
      'directory',
      draft(),
      inspection({ alreadyAdded: { id: 'p1', name: 'Award Tracker' } })
    )
    expect(blockers).toEqual(['This directory is already the project “Award Tracker”.'])
  })

  it('refuses a directory that is not there unless creating it was asked for', () => {
    const missing = inspection({ exists: false })
    expect(stepBlockers('directory', draft(), missing)).toEqual([
      'That directory does not exist. Tick “Create it” or choose another.'
    ])
    expect(stepBlockers('directory', draft({ createDirectory: true }), missing)).toEqual([])
  })

  it('refuses a path that is a file', () => {
    expect(stepBlockers('directory', draft(), inspection({ isDirectory: false }))).toEqual([
      'That path is a file, not a directory.'
    ])
  })

  it('asks for a name', () => {
    expect(stepBlockers('directory', draft({ name: '  ' }), inspection())).toEqual([
      'Give the project a name.'
    ])
  })
})

describe('leaving the setup step', () => {
  it('passes on the defaults', () => {
    expect(stepBlockers('setup', draft(), inspection())).toEqual([])
  })

  it('repeats the daemon’s own refusal of a workspace directory, verbatim', () => {
    // ⛔ The renderer never re-derives this. `project.inspect` decided it, because deciding it needs
    // a filesystem and the list of every other project's pool.
    const blockers = stepBlockers(
      'setup',
      draft(),
      inspection({
        workspace: {
          path: 'C:/dev/thing/ws',
          state: 'inside-project',
          takenBy: null,
          usable: false,
          note: 'This is inside the project, so every worktree would be a subdirectory of the repository.',
          relative: 'ws'
        }
      })
    )
    expect(blockers).toEqual([
      'This is inside the project, so every worktree would be a subdirectory of the repository.'
    ])
  })

  it('refuses a pool size the daemon would refuse, and accepts trunk-only zero', () => {
    // ⚠️ Zero is trunk-only — no pool at all — and the daemon accepts it; see `trunkonly.test.ts`.
    expect(stepBlockers('setup', draft({ poolSize: 0 }), inspection())).toEqual([])
    expect(stepBlockers('setup', draft({ poolSize: 33 }), inspection())).toEqual([
      'The workspace pool must be between 0 and 32 (0 is trunk-only).'
    ])
    expect(stepBlockers('setup', draft({ poolSize: -1 }), inspection())).toEqual([
      'The workspace pool must be between 0 and 32 (0 is trunk-only).'
    ])
  })

  it('refuses an empty landing target', () => {
    expect(stepBlockers('setup', draft({ landingTarget: ' ' }), inspection())).toEqual([
      'Name the branch this project’s work lands on.'
    ])
  })
})

describe('whether the project ends up with a repository', () => {
  it('is true for one that already has it, and for one the wizard will initialise', () => {
    expect(willHaveRepo(inspection(), draft())).toBe(true)
    expect(willHaveRepo(inspection({ vcs: 'none' }), draft({ gitInit: true }))).toBe(true)
    expect(willHaveRepo(inspection({ vcs: 'none' }), draft())).toBe(false)
  })
})

describe('what Create will do', () => {
  it('names every write, including the file it puts in the repository', () => {
    const plan = creationPlan(draft({ checksText: 'npm test\n\n  npm run lint  ' }), inspection())
    expect(plan).toContain('Add “thing” as a project.')
    expect(plan).toContain(
      'Write .warmstart/project.json with these policies — a new file in the repository.'
    )
    expect(plan).toContain('Record 2 check commands.')
  })

  it('says an existing committed config is being updated, not created', () => {
    expect(creationPlan(draft(), inspection({ hasConfig: true }))).toContain(
      'Update the committed .warmstart/project.json with these policies.'
    )
  })

  it('says the scaffolding commits so the trunk starts clean', () => {
    expect(creationPlan(draft(), inspection())).toContain(
      'Commit the scaffolding so the trunk starts clean.'
    )
  })

  it('states the ignore choice instead of the commit when asked', () => {
    // ⛔ t554: the wizard asks what project.json becomes in git, so the plan must say the answer —
    // a review step that hid the git fate would leave it to be discovered in `git status`.
    const plan = creationPlan(draft({ scaffoldingGit: 'ignore' }), inspection())
    expect(plan).toContain(
      'Write .warmstart/project.json with these policies, add it to .gitignore, and commit that rule — the config itself stays untracked.'
    )
    expect(plan.join('\n')).not.toContain('Commit the scaffolding')
  })

  it('says out loud that no checks means the verifying policies verify nothing', () => {
    expect(creationPlan(draft(), inspection())).toContain(
      'Record no check commands — verifying finish policies would verify nothing.'
    )
  })

  it('says what a project with no repository gives up', () => {
    // ⚠️ The consequence of an unticked box two steps back, and visible nowhere else.
    expect(creationPlan(draft(), inspection({ vcs: 'none' }))).toContain(
      'Run with no repository: one workspace, no branches, and nothing to land onto.'
    )
  })

  it('names the directory it will create and the branch it will initialise', () => {
    const plan = creationPlan(
      draft({ createDirectory: true, gitInit: true, landingTarget: 'trunk' }),
      inspection({ exists: false, vcs: 'none', root: 'C:/dev/new' })
    )
    expect(plan).toContain('Create C:/dev/new.')
    expect(plan).toContain('Run git init -b trunk in C:/dev/new.')
  })

  it('names the starter files it will write', () => {
    const plan = creationPlan(
      draft({
        docs: [
          { name: 'AGENTS.md', include: true, content: 'x', edited: false },
          { name: 'HANDOFF.md', include: false, content: 'x', edited: false }
        ]
      }),
      inspection()
    )
    expect(plan).toContain('Write AGENTS.md into the project directory.')
    expect(plan.join('\n')).not.toContain('HANDOFF.md')
  })
})

describe('the check list and the template signature', () => {
  it('reads one command per line, trimmed, blanks dropped', () => {
    expect(checksFromText('  npm test \n\n\n  ruff check .  \n')).toEqual([
      'npm test',
      'ruff check .'
    ])
  })

  it('changes when a template would quote something different, and not otherwise', () => {
    const base = draft({ checksText: 'npm test' })
    expect(docSignature(base)).toBe(docSignature(draft({ checksText: '  npm test  \n' })))
    expect(docSignature(base)).not.toBe(docSignature(draft({ ...base, landingTarget: 'trunk' })))
    expect(docSignature(base)).not.toBe(docSignature(draft({ ...base, name: 'other' })))
  })
})
