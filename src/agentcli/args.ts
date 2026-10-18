import { z, type ZodRawShape, type ZodType } from 'zod'
import type { WorkerTool } from '../mcp/workertools.js'

/**
 * The pure half of `warmstart-agent`: turning a command line into a tool's arguments, and a tool's
 * schema into help text.
 *
 * ⛔ **Separate from `index.ts` for the reason `src/mcp/payload.ts` is separate from its server:**
 * the entry point reads the environment, opens a socket and exits the process, so nothing in it could
 * be loaded by a check. Nothing here does any of that.
 *
 * ⚠️ **The flags are read off the very zod schema the MCP server registers** (`workertools.ts`), so
 * the helper cannot accept an argument the tool would refuse, or miss one it gained. Scalars and lists
 * of scalars are flags; anything shaped like an object — `task_split`'s `pieces`, `debate_round`'s
 * `briefs` — is JSON, given as the flag's value or inside `--json` / `--args-file`, because no
 * flag spelling survives `cmd.exe`, PowerShell and a POSIX shell alike for a nested structure.
 */

export type FlagKind = 'string' | 'number' | 'boolean' | 'list' | 'json'

export interface FlagSpec {
  key: string
  flag: string
  kind: FlagKind
  required: boolean
  description: string
  choices?: string[]
}

function unwrap(schema: ZodType): { inner: ZodType; optional: boolean } {
  let inner = schema
  let optional = false
  while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault || inner instanceof z.ZodNullable) {
    optional = true
    inner = (inner as z.ZodOptional<ZodType>).unwrap()
  }
  return { inner, optional }
}

function isScalar(schema: ZodType): boolean {
  return schema instanceof z.ZodString || schema instanceof z.ZodNumber || schema instanceof z.ZodEnum
}

function kindOf(schema: ZodType): FlagKind {
  if (schema instanceof z.ZodBoolean) return 'boolean'
  if (schema instanceof z.ZodNumber) return 'number'
  if (schema instanceof z.ZodString || schema instanceof z.ZodEnum) return 'string'
  if (schema instanceof z.ZodArray && isScalar(unwrap(schema.element as ZodType).inner)) return 'list'
  // ⚠️ `ask_human`'s `options` is "a list of labels, or of {label, detail}, or one JSON string":
  // repeating `--option` gives the first, and a JSON value is still read as JSON. See `coerce`.
  if (schema instanceof z.ZodUnion) {
    const arms = (schema.options as ZodType[]).map((arm) => unwrap(arm).inner)
    if (arms.some((arm) => arm instanceof z.ZodArray)) return 'list'
  }
  return 'json'
}

/** `pr_title` → `--pr-title`. */
export function flagName(key: string): string {
  return `--${key.replace(/_/g, '-').replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

export function flagsOf(shape: ZodRawShape): FlagSpec[] {
  const specs: FlagSpec[] = []
  const seen = new Set<string>()
  for (const [key, raw] of Object.entries(shape)) {
    const schema = raw as ZodType
    const { inner, optional } = unwrap(schema)
    const description = schema.description ?? inner.description ?? ''
    // ⚠️ An alias (`prTitle` beside `pr_title`) spells the same flag; the first key keeps it.
    // A list is spelled one entry at a time, so `options` is `--option`, repeated (the plural is
    // still read; see `parseArgs`).
    const kind = kindOf(inner)
    const flag = flagName(kind === 'list' ? key.replace(/s$/, '') : key)
    if (seen.has(flag)) continue
    seen.add(flag)
    specs.push({
      key,
      flag,
      kind,
      required: !optional,
      description,
      ...(inner instanceof z.ZodEnum ? { choices: (inner.options as unknown[]).map(String) } : {})
    })
  }
  return specs
}

/** `task-complete`, `task_complete` and `TASK_COMPLETE` all name one tool. */
export function toolNamed(tools: WorkerTool[], name: string): WorkerTool | undefined {
  const wanted = name.trim().toLowerCase().replace(/-/g, '_')
  return tools.find((tool) => tool.name === wanted)
}

export type ParseResult =
  | { ok: true; args: Record<string, unknown>; argsFile?: string }
  | { ok: false; error: string }

function coerce(spec: FlagSpec, value: string): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (spec.kind) {
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: `${spec.flag} takes a number, not '${value}'` }
    }
    case 'boolean':
      if (/^(true|yes|1)$/i.test(value)) return { ok: true, value: true }
      if (/^(false|no|0)$/i.test(value)) return { ok: true, value: false }
      return { ok: false, error: `${spec.flag} takes true or false, not '${value}'` }
    case 'json':
      try {
        return { ok: true, value: JSON.parse(value) as unknown }
      } catch {
        return { ok: false, error: `${spec.flag} takes JSON, and '${value.slice(0, 60)}' is not JSON` }
      }
    default:
      return { ok: true, value }
  }
}

/**
 * Read `--flag value`, `--flag=value`, a bare boolean `--flag`, repeated list flags, `--json '{…}'`
 * and `--args-file <path>`. One leading positional fills the tool's first required text argument, so
 * `warmstart-agent task_complete "Fixed the parser"` reads the way it looks.
 *
 * ⚠️ `--args-file` is returned rather than read, so this stays free of the filesystem; the caller
 * merges what it holds *under* the flags, which win.
 */
export function parseArgs(tool: WorkerTool, argv: string[]): ParseResult {
  const specs = flagsOf(tool.config.inputSchema)
  const byFlag = new Map<string, FlagSpec>()
  for (const spec of specs) {
    byFlag.set(spec.flag, spec)
    byFlag.set(`--${spec.key}`, spec)
    byFlag.set(flagName(spec.key), spec)
  }
  const args: Record<string, unknown> = {}
  let argsFile: string | undefined
  const positionals: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? ''
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? undefined : token.slice(eq + 1)
    const takeValue = (): string | undefined => {
      if (inline !== undefined) return inline
      const next = argv[i + 1]
      if (next === undefined) return undefined
      i++
      return next
    }

    if (name === '--json') {
      const value = takeValue()
      if (value === undefined) return { ok: false, error: '--json needs a JSON object' }
      let parsed: unknown
      try {
        parsed = JSON.parse(value)
      } catch {
        return { ok: false, error: '--json takes a JSON object, and that is not JSON' }
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: '--json takes a JSON object, like {"summary": "…"}' }
      }
      Object.assign(args, parsed)
      continue
    }
    if (name === '--args-file') {
      const value = takeValue()
      if (!value) return { ok: false, error: '--args-file needs a path, or - for standard input' }
      argsFile = value
      continue
    }

    const spec = byFlag.get(name.toLowerCase()) ?? byFlag.get(flagName(name.slice(2)))
    if (!spec) {
      return { ok: false, error: `${tool.name} has no ${name}. Run \`warmstart-agent help ${tool.name}\`.` }
    }
    if (spec.kind === 'boolean' && inline === undefined) {
      const next = argv[i + 1]
      if (next !== undefined && /^(true|false|yes|no|1|0)$/i.test(next)) {
        i++
        args[spec.key] = /^(true|yes|1)$/i.test(next)
      } else {
        args[spec.key] = true
      }
      continue
    }
    const value = takeValue()
    if (value === undefined) return { ok: false, error: `${spec.flag} needs a value` }
    if (spec.kind === 'list') {
      // A value that is itself a JSON list is the whole list; anything else is one more entry.
      if (value.trim().startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(value)
          if (Array.isArray(parsed)) {
            args[spec.key] = [...((args[spec.key] as unknown[] | undefined) ?? []), ...(parsed as unknown[])]
            continue
          }
        } catch {
          // Not JSON after all: an entry that happens to start with a bracket.
        }
      }
      args[spec.key] = [...((args[spec.key] as unknown[] | undefined) ?? []), value]
      continue
    }
    const coerced = coerce(spec, value)
    if (!coerced.ok) return { ok: false, error: coerced.error }
    args[spec.key] = coerced.value
  }

  if (positionals.length > 0) {
    const first = specs.find((spec) => spec.required && spec.kind === 'string' && args[spec.key] === undefined)
    if (!first || positionals.length > 1) {
      return {
        ok: false,
        error:
          `unexpected argument${positionals.length > 1 ? 's' : ''} ${positionals.map((p) => `'${p}'`).join(' ')}. ` +
          `Quote text that has spaces, and name every other value with its flag.`
      }
    }
    args[first.key] = positionals[0]
  }
  return { ok: true, args, ...(argsFile ? { argsFile } : {}) }
}

/** Check parsed arguments against the tool's own schema, and say what is wrong in flag terms. */
export function validateArgs(tool: WorkerTool, args: Record<string, unknown>): string | null {
  const result = z.object(tool.config.inputSchema).safeParse(args)
  if (result.success) return null
  return result.error.issues
    .map((issue) => {
      const key = String(issue.path[0] ?? '')
      const where = key ? `${flagName(key)}${issue.path.length > 1 ? ` (${issue.path.slice(1).join('.')})` : ''}` : 'arguments'
      return `${where}: ${issue.message}`
    })
    .join('\n')
}

function wrap(text: string, indent: string, width = 96): string {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line && line.length + 1 + word.length > width - indent.length) {
      lines.push(indent + line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(indent + line)
  return lines.join('\n')
}

const USAGE_NOTES = [
  'Usage: warmstart-agent <tool> [--flag value]... [--json \'{...}\'] [--args-file <path>|-]',
  '',
  'Warmstart\'s worker tools, for an agent whose CLI has no MCP. Every call acts for the session',
  'Warmstart started you in, and only while your run is open.',
  '',
  'A call that needs a person (ask_human, checkpoint, request_directory, a task_split approval, a',
  'converged debate_round) files a card for the operator and ENDS this run: stop when it says so,',
  'and you are started again with the answer. task_complete and land_work may take minutes while',
  'the project\'s checks run; let them finish.'
]

export function usage(tools: WorkerTool[]): string {
  const width = Math.max(...tools.map((tool) => tool.name.length))
  return [
    ...USAGE_NOTES,
    '',
    'Tools:',
    ...tools.map((tool) => `  ${tool.name.padEnd(width)}  ${tool.config.title}`),
    '',
    'Run `warmstart-agent help <tool>` for its flags.'
  ].join('\n')
}

export function toolHelp(tool: WorkerTool): string {
  const specs = flagsOf(tool.config.inputSchema)
  const lines = [`warmstart-agent ${tool.name} — ${tool.config.title}`, '', wrap(tool.config.description, ''), '']
  if (specs.length === 0) {
    lines.push('Takes no arguments.')
  } else {
    lines.push('Flags:')
    for (const spec of specs) {
      const value =
        spec.kind === 'boolean'
          ? ''
          : spec.kind === 'list'
            ? ' <text> (repeatable)'
            : spec.kind === 'json'
              ? ' <JSON>'
              : spec.choices
                ? ` <${spec.choices.join('|')}>`
                : spec.kind === 'number'
                  ? ' <number>'
                  : ' <text>'
      lines.push(`  ${spec.flag}${value}${spec.required ? '  (required)' : ''}`)
      if (spec.description) lines.push(wrap(spec.description, '      '))
    }
  }
  return lines.join('\n')
}
