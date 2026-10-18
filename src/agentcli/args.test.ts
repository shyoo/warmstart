import { describe, expect, it } from 'vitest'
import { workerTools, type WorkerToolIo } from '../mcp/workertools.js'
import { flagName, flagsOf, parseArgs, toolHelp, toolNamed, usage, validateArgs } from './args.js'

/**
 * `warmstart-agent`'s command line, read off the same schemas the MCP server registers.
 *
 * ⚠️ The tools under test are the real worker tier, not fixtures: if a tool gains, loses or renames
 * an argument, this is where the helper's spelling of it is pinned.
 */

const sent: Array<{ method: string; params: unknown }> = []
const io: WorkerToolIo = {
  sessionId: '',
  rpc: async (method, params) => {
    sent.push({ method, params })
    return { ok: true, reply: 'ok' } as never
  },
  held: async (_extra, method, params) => {
    sent.push({ method, params })
    return { ok: true, reply: 'ok' } as never
  }
}
const tools = workerTools(io)

function tool(name: string) {
  const found = toolNamed(tools, name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

describe('the tools', () => {
  it('are the whole worker tier, and approve is not among them', () => {
    // ⛔ `approve` is the permission-prompt hook, which no shell helper can be.
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'ask_human',
        'await_human',
        'checkpoint',
        'debate_round',
        'handoff',
        'land_work',
        'project_settings',
        'request_directory',
        'task_complete',
        'task_create',
        'task_depend',
        'task_read',
        'task_split'
      ].sort()
    )
  })

  it('are found by any spelling of their name', () => {
    expect(toolNamed(tools, 'task-complete')?.name).toBe('task_complete')
    expect(toolNamed(tools, 'TASK_COMPLETE')?.name).toBe('task_complete')
    expect(toolNamed(tools, 'delete_task')).toBeUndefined()
  })
})

describe('reading a command line', () => {
  it('takes one positional as the first required text argument', () => {
    const parsed = parseArgs(tool('task_complete'), ['Fixed the parser', '--pr-title', 'Fix parser'])
    expect(parsed).toEqual({ ok: true, args: { summary: 'Fixed the parser', pr_title: 'Fix parser' } })
  })

  it('reads --flag=value and the snake spelling alike', () => {
    const parsed = parseArgs(tool('task_complete'), ['--summary=done', '--pr_body', 'body'])
    expect(parsed).toEqual({ ok: true, args: { summary: 'done', pr_body: 'body' } })
  })

  it('repeats a list flag, so a question gets its options as buttons', () => {
    const parsed = parseArgs(tool('ask_human'), ['Which parser?', '--option', 'Hand-written', '--option', 'Generated', '--multi-select'])
    expect(parsed).toEqual({
      ok: true,
      args: { question: 'Which parser?', options: ['Hand-written', 'Generated'], multi_select: true }
    })
  })

  it('reads numbers as numbers', () => {
    const parsed = parseArgs(tool('task_depend'), ['--task', '12', '--depends-on', '11'])
    expect(parsed).toEqual({ ok: true, args: { task: 12, depends_on: 11 } })
    expect(parseArgs(tool('task_depend'), ['--task', 'twelve']).ok).toBe(false)
  })

  it('takes a nested structure as JSON, and says so when it is not', () => {
    const pieces = [{ instruction: 'Write the parser', depends_on: [] }]
    const parsed = parseArgs(tool('task_split'), ['--pieces', JSON.stringify(pieces)])
    expect(parsed).toEqual({ ok: true, args: { pieces } })
    const bad = parseArgs(tool('task_split'), ['--pieces', 'write the parser'])
    expect(bad.ok).toBe(false)
  })

  it('merges --json under nothing and over nothing it was not given', () => {
    const parsed = parseArgs(tool('await_human'), ['--json', '{"reason":"yours now","state":"half done"}'])
    expect(parsed).toEqual({ ok: true, args: { reason: 'yours now', state: 'half done' } })
  })

  it('hands --args-file back to the caller rather than reading the disk', () => {
    const parsed = parseArgs(tool('task_split'), ['--args-file', '-'])
    expect(parsed).toEqual({ ok: true, args: {}, argsFile: '-' })
  })

  it('refuses a flag the tool does not have, naming the help that lists them', () => {
    const parsed = parseArgs(tool('handoff'), ['--force'])
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('warmstart-agent help handoff')
  })

  it('refuses a second positional instead of guessing which argument it was', () => {
    expect(parseArgs(tool('task_complete'), ['one', 'two']).ok).toBe(false)
  })
})

describe('checking against the schema', () => {
  it('names a missing required argument by its flag', () => {
    expect(validateArgs(tool('handoff'), {})).toContain('--note')
    expect(validateArgs(tool('handoff'), { note: 'x' })).toBeNull()
  })

  it('refuses a finish policy the tool does not offer', () => {
    expect(validateArgs(tool('land_work'), { finishPolicy: 'force-push' })).toContain('--finish-policy')
  })
})

describe('calling through', () => {
  it('sends the same RPC the MCP server would, with the approval card when given one', async () => {
    sent.length = 0
    await tool('task_split').handler({ approval: '0123abcd' })
    expect(sent).toEqual([{ method: 'agent.split', params: { sessionId: '', approval: '0123abcd', pieces: [] } }])
  })
})

describe('help', () => {
  it('lists every tool and says that a call needing a person ends the run', () => {
    const text = usage(tools)
    for (const t of tools) expect(text).toContain(t.name)
    expect(text).toMatch(/ENDS this run/)
  })

  it('shows each flag once, aliases folded', () => {
    const specs = flagsOf(tool('task_complete').config.inputSchema)
    expect(specs.map((s) => s.flag)).toEqual(['--summary', '--pr-title', '--pr-body'])
    expect(toolHelp(tool('land_work'))).toContain('<commit-and-merge|commit-and-push|pull-request>')
    expect(flagName('dependsOn')).toBe('--depends-on')
    expect(flagsOf(tool('ask_human').config.inputSchema).map((s) => s.flag)).toContain('--option')
    expect(parseArgs(tool('ask_human'), ['q', '--options', 'A'])).toEqual({ ok: true, args: { question: 'q', options: ['A'] } })
  })
})
