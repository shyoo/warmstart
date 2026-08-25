import { describe, expect, it } from 'vitest'
import { narrowMandate } from './tasks.js'
import { matchesPattern, parseRule } from './approvals.js'
import { branchNameFor } from './worktrees.js'
import { ROOT_MANDATE } from '@shared/tasks.js'

/**
 * The parts of M2 that are pure functions, and that are safety boundaries rather than conveniences.
 * Each of these is a place where being wrong is silent: a widened mandate, an over-broad rule, or a
 * branch name that couples a task to whichever workspace it happened to land in.
 */

describe('narrowMandate', () => {
  it('never grants an operation the parent does not hold', () => {
    const parent = { ...ROOT_MANDATE, allowed: ['read', 'write'] as const }
    const child = narrowMandate({ ...parent, allowed: ['read', 'write'] }, {
      allowed: ['read', 'write', 'push', 'land']
    })
    expect(child.allowed).toEqual(['read', 'write'])
  })

  it('lets a creator hand over less than it holds', () => {
    const child = narrowMandate(ROOT_MANDATE, { allowed: ['read'] })
    expect(child.allowed).toEqual(['read'])
  })

  it('spends depth rather than resetting it', () => {
    const child = narrowMandate({ ...ROOT_MANDATE, maxLineageDepth: 1 }, { maxLineageDepth: 99 })
    expect(child.maxLineageDepth).toBe(1)
  })

  it('caps fan-out at the parent, whatever the child asks for', () => {
    const child = narrowMandate({ ...ROOT_MANDATE, maxChildren: 2 }, { maxChildren: 50 })
    expect(child.maxChildren).toBe(2)
  })
})

describe('parseRule', () => {
  it('reads Tool(pattern)', () => {
    expect(parseRule('Bash(npm test)')).toEqual({ tool: 'Bash', pattern: 'npm test' })
  })

  it('treats a bare tool name as every use of it', () => {
    expect(parseRule('Edit')).toEqual({ tool: 'Edit', pattern: '*' })
  })

  it('rejects nonsense rather than guessing', () => {
    expect(parseRule('')).toBeNull()
    expect(parseRule('(nope)')).toBeNull()
  })
})

describe('matchesPattern', () => {
  it('matches exactly by default', () => {
    expect(matchesPattern('npm test', 'npm test')).toBe(true)
    expect(matchesPattern('npm test', 'npm test -- --watch')).toBe(false)
  })

  it('supports a trailing wildcard', () => {
    expect(matchesPattern('git *', 'git status')).toBe(true)
    expect(matchesPattern('git *', 'npm run git')).toBe(false)
  })

  it('treats regex metacharacters in a rule as literal text', () => {
    // A rule is a safety boundary. A mistyped regex that happens to match everything is exactly the
    // failure this must not have.
    expect(matchesPattern('rm -rf .', 'rm -rf x')).toBe(false)
    expect(matchesPattern('npm run build|test', 'npm run build')).toBe(false)
  })
})

describe('branchNameFor', () => {
  it('names the branch after the task, never the workspace', () => {
    expect(branchNameFor(12, 'Fix the dialog')).toBe('agentyard/t12-fix-the-dialog')
  })

  it('is stable for the same task regardless of where it runs', () => {
    expect(branchNameFor(7, 'Same title')).toBe(branchNameFor(7, 'Same title'))
  })

  it('survives a title made entirely of punctuation', () => {
    expect(branchNameFor(3, '!!!')).toBe('agentyard/t3')
  })
})
