import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterInfo } from '@shared/protocol.js'
import type { AgentAdapter } from './types.js'
import { paths } from '../paths.js'
import { log } from '../log.js'
import { genericAdapter } from './generic.js'

/**
 * Adapters an operator can add without waiting for a release.
 *
 * ⛔ **Declarative JSON, never JavaScript.** Loading code from a data directory would mean a file
 * anything on the machine can write gets executed inside the daemon — the one process that holds the
 * RPC token, spawns agents, and knows where every credential root is. A capability table cannot do
 * that. So an external adapter describes *what its CLI is like* and the generic driver does the work.
 *
 * The trade is real and worth stating: an external adapter cannot parse a novel stream dialect, and
 * so cannot be metered from one. It gets `metering: 'none'` unless it writes a transcript, and
 * everything downstream reports its cost as **unknown** rather than as zero. A CLI that needs more
 * than this needs a real adapter in `src/daemon/adapters/`, which is a pull request, not a config file.
 *
 * File: `<dataDir>/adapters/<id>.json`. Doctor lists what loaded and what did not, and why.
 */

/** What an operator may declare. Anything absent takes the conservative default. */
export interface ExternalAdapterFile {
  schema_version: number
  id: string
  label: string
  command: string
  isolation_env_var?: string | null
  /** Argv placed before the prompt for a non-interactive run. `{{cwd}}` and `{{model}}` expand. */
  print_args?: string[]
  login_args?: string[]
  version_args?: string[]
  cost_model_id: string
  capabilities?: Partial<AdapterInfo['capabilities']>
  policy?: Partial<AdapterInfo['policy']>
}

export interface ExternalLoadResult {
  adapters: AgentAdapter[]
  /** One line per file that did not load, for Doctor. ⛔ Never thrown: a bad file is not a dead app. */
  problems: string[]
}

export function externalAdapterDir(): string {
  return join(paths.root, 'adapters')
}

/**
 * ⛔ Conservative on every axis an operator did not state.
 *
 * A declaration that omits `manualCompact` gets `false`, not `true`. Claiming a capability that is
 * absent strands a session at a window boundary; omitting one that is present costs a missed
 * optimisation. That asymmetry is why every default below is the pessimistic one.
 */
function capabilitiesFrom(file: ExternalAdapterFile): AdapterInfo['capabilities'] {
  const declared = file.capabilities ?? {}
  return {
    transports: declared.transports ?? ['pty'],
    permissionModes: declared.permissionModes ?? [],
    classifierBackedAuto: declared.classifierBackedAuto ?? false,
    approvalChannel: declared.approvalChannel ?? 'none',
    manualCompact: declared.manualCompact ?? false,
    resumeSession: declared.resumeSession ?? false,
    forkSession: declared.forkSession ?? false,
    nativeWorktree: declared.nativeWorktree ?? false,
    multimodalInput: declared.multimodalInput ?? false,
    // ⛔ Not negotiable from a config file. agentyard's MCP server carries a per-session identity, and
    // a declarative adapter has no way to pass one - a session that believed it could call
    // `task_complete` and could not would finish and report nothing, which looks like a hang.
    mcp: false,
    // ⛔ Not negotiable either. The effort flag would have to be a declared argv template, and a
    // declaration that got it wrong would fail at spawn on somebody's account rather than here.
    selectableEffort: false,
    quotaProbe: 'none',
    // ⛔ Also not negotiable. Minting a session id means agentyard can prove a process is its own and
    // may kill it. A declaration cannot grant itself that.
    mintsSessionId: false,
    // No decoder can be declared, so there is nothing to meter from. `none` is what makes the rest of
    // the system say *unknown* rather than quietly sum to zero.
    metering: 'none',
    maxAccounts: declared.maxAccounts ?? (file.isolation_env_var ? null : 1)
  }
}

function policyFrom(file: ExternalAdapterFile): AdapterInfo['policy'] {
  const declared = file.policy ?? {}
  return {
    defaultPermissionMode: declared.defaultPermissionMode ?? '',
    interruptSequence: declared.interruptSequence ?? '\x1b',
    costModelId: file.cost_model_id,
    // With no compaction declared, the only wrap-up available is a handoff.
    wrapUpProtocol: declared.wrapUpProtocol ?? 'handoff',
    needsExplicitBudget: declared.needsExplicitBudget ?? true
  }
}

const ID = /^[a-z][a-z0-9-]{1,40}$/

/** ⛔ Validated before anything is built. A malformed declaration is reported, never half-applied. */
export function parseExternalAdapter(raw: unknown, source: string): ExternalAdapterFile | string {
  if (!raw || typeof raw !== 'object') return `${source}: not a JSON object`
  const file = raw as Partial<ExternalAdapterFile>

  if (file.schema_version !== 1) return `${source}: unsupported schema_version ${file.schema_version}`
  if (typeof file.id !== 'string' || !ID.test(file.id)) {
    return `${source}: id must be lower-case letters, digits and dashes`
  }
  if (typeof file.label !== 'string' || !file.label.trim()) return `${source}: needs a label`
  if (typeof file.command !== 'string' || !file.command.trim()) return `${source}: needs a command`
  // ⛔ A command is looked up on PATH, never run through a shell. A declaration that could smuggle
  // shell syntax into `command` would be arbitrary execution by another name.
  if (/[\s;&|<>"'`$]/.test(file.command)) {
    return `${source}: command must be a bare executable name, with no arguments or shell characters`
  }
  if (typeof file.cost_model_id !== 'string' || !file.cost_model_id.trim()) {
    return `${source}: needs a cost_model_id - a CLI that cannot be priced is one that cannot be gated`
  }
  for (const key of ['print_args', 'login_args', 'version_args'] as const) {
    const value = file[key]
    if (value !== undefined && (!Array.isArray(value) || value.some((a) => typeof a !== 'string'))) {
      return `${source}: ${key} must be a list of strings`
    }
  }
  return file as ExternalAdapterFile
}

/**
 * Read `<dataDir>/adapters/*.json`.
 *
 * ⛔ Never throws and never rejects the whole directory for one bad file. An operator with a typo in
 * one adapter should lose that adapter, not their fleet.
 */
export function loadExternalAdapters(dir = externalAdapterDir()): ExternalLoadResult {
  const adapters: AgentAdapter[] = []
  const problems: string[] = []
  if (!existsSync(dir)) return { adapters, problems }

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const full = join(dir, name)
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(full, 'utf8'))
    } catch (err) {
      problems.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
      continue
    }
    const parsed = parseExternalAdapter(raw, name)
    if (typeof parsed === 'string') {
      problems.push(parsed)
      continue
    }
    adapters.push(
      genericAdapter({
        info: {
          id: parsed.id,
          label: parsed.label,
          command: parsed.command,
          isolationEnvVar: parsed.isolation_env_var ?? null,
          capabilities: capabilitiesFrom(parsed),
          policy: policyFrom(parsed),
          // ⛔ A declared adapter gets no usage refresh, for the same reason it gets no quota
          // probe and no metering: nothing here has been measured, and a number nobody verified is
          // worse than no number. Its runs stay marked unverified.
          usageRefresh: null,
          firstRun: null,
          // ⚠️ `"login_args": null` in the declaration means this CLI has no login to run - the
          // same answer Antigravity gives, and a real one. Omitting the key keeps the old default.
          login:
            parsed.login_args === null
              ? {
                  kind: 'external',
                  reason:
                    `${parsed.label} declares no CLI login. Sign this account in however its vendor ` +
                    'expects, then commission it here.'
                }
              : { kind: 'cli', argv: parsed.login_args ?? ['login'] },
          verification: {
            level: 'documented',
            asOf: new Date().toISOString().slice(0, 10),
            // ⛔ Never `measured`. agentyard did not establish any of this; somebody wrote it in a
            // file, and Doctor should say so in exactly those words.
            note:
              `Declared by the operator in ${name}. Multi Agent Controller has verified none of it, cannot meter ` +
              'this adapter, and will not stop its orphaned processes.'
          }
        },
        printArgs: parsed.print_args ?? [],
        versionArgs: parsed.version_args ?? ['--version']
      })
    )
  }

  if (adapters.length) log.info(`loaded ${adapters.length} external adapter(s) from ${dir}`)
  for (const problem of problems) log.warn(`external adapter ignored - ${problem}`)
  return { adapters, problems }
}
