import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterDetection, AdapterInfo, QuotaSnapshot } from '@shared/protocol.js'
import type { AgentAdapter, IdentityProbe, SpawnPlan, SpawnRequest } from './types.js'
import { launchArgs, launchable, which } from '../which.js'

/**
 * The driver behind a declarative adapter (`external.ts`).
 *
 * ⛔ Everything a built-in adapter knows about its CLI — where the transcript lands, how to read
 * identity without spending, what the stream records mean — is exactly what a JSON file cannot
 * express. So this driver does the only things that can be done from a declaration: find the binary,
 * read its version, build an argv, and honestly report *unknown* for the rest.
 *
 * ⚠️ That is a real ceiling, not a stub to fill in later. A CLI that deserves better deserves a real
 * adapter in this directory, where its quirks can be measured and written down. This exists so that
 * trying one out does not require a release.
 */

const run = promisify(execFile)

export interface GenericAdapterSpec {
  info: AdapterInfo
  /** Argv for a non-interactive run, before the prompt. `{{cwd}}` and `{{model}}` expand. */
  printArgs: string[]
  versionArgs: string[]
}

function expand(args: string[], req: SpawnRequest): string[] {
  return args
    .map((arg) => arg.replace('{{cwd}}', req.cwd).replace('{{model}}', req.model ?? ''))
    // A `{{model}}` in a declaration with no model chosen would otherwise pass an empty argument,
    // which most CLIs read as a positional prompt.
    .filter((arg) => arg !== '')
}

export function genericAdapter(spec: GenericAdapterSpec): AgentAdapter {
  const { info } = spec

  function envFor(isolationRoot: string): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    if (info.isolationEnvVar) env[info.isolationEnvVar] = isolationRoot
    return env
  }

  return {
    info,

    isInstalled(): boolean {
      return which(info.command) !== null
    },

    async detect(): Promise<AdapterDetection> {
      const resolved = which(info.command)
      if (!resolved) {
        return {
          adapterId: info.id,
          found: false,
          path: null,
          version: null,
          error: `'${info.command}' is not on PATH`
        }
      }
      try {
        const probe = launchArgs(resolved, spec.versionArgs)
        const { stdout } = await run(probe.command, probe.args, { timeout: 15_000 })
        return {
          adapterId: info.id,
          found: true,
          path: resolved,
          version: stdout.trim().split(/\s+/).pop() ?? stdout.trim()
        }
      } catch (err) {
        return {
          adapterId: info.id,
          found: false,
          path: null,
          version: null,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    },

    /**
     * ⛔ Always unknown. There is no declarative way to say "read identity from here without spending
     * a turn", and guessing at one would either be wrong or cost money. Reporting `null` is what makes
     * the scheduler's not-signed-in gate treat this worker as unproven rather than as ready.
     */
    async probeIdentity(isolationRoot: string): Promise<IdentityProbe> {
      const root = info.isolationEnvVar ? isolationRoot : null
      return {
        loggedIn: null,
        raw:
          `Sign-in state cannot be read for a declared adapter${root ? ` at ${root}` : ''}. ` +
          'A failed run will say so; nothing here spends a turn to find out.'
      }
    },

    /** ⛔ Always unknown, for the same reason, and the run is marked `quotaUnverified`. */
    async probeQuota(): Promise<Omit<QuotaSnapshot, 'workerId'>> {
      return {
        windows: [],
        sampledAt: Date.now(),
        source: 'unknown',
        error: 'a declared adapter has no quota probe; its runs are marked unverified'
      }
    },

    plan(req: SpawnRequest): SpawnPlan {
      const env = envFor(req.isolationRoot)
      const resolved = which(info.command)
      if (!resolved) throw new Error(`'${info.command}' is not on PATH`)
      const { command, prefixArgs } = launchable(resolved)

      if (req.argv) return { command, args: [...prefixArgs, ...req.argv], env }
      return { command, args: [...prefixArgs, ...expand(spec.printArgs, req)], env }
    },

    /**
     * ⛔ Null, and no `discoverTranscript` either.
     *
     * A declaration cannot say where a CLI writes its transcript or in what shape, and a wrong guess
     * would attach the tailer to somebody else's file and meter their work as agentyard's. So this
     * adapter's `metering` is `none`, and the honest consequence — cost *unknown*, never zero —
     * propagates from there.
     */
    transcriptPath(): string | null {
      return null
    }
  }
}

/** Where a declared adapter's isolation root goes, if it declared a variable for one. */
export function externalRootFor(root: string, id: string): string {
  return existsSync(root) ? root : join(root, id)
}
