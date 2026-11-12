import { execFile, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'

export function createRun(exec: typeof execFile = execFile) {
  const baseRun = promisify(exec)

  return ((file: string, ...rest: unknown[]) => {
    if (Array.isArray(rest[0])) {
      const [args, options] = rest as [readonly string[], ExecFileOptions | undefined]
      return baseRun(file, args, { windowsHide: true, ...options })
    }
    if (rest[0] && typeof rest[0] === 'object') {
      const [options] = rest as [ExecFileOptions]
      return baseRun(file, { windowsHide: true, ...options })
    }
    return baseRun(file, { windowsHide: true })
  }) as typeof baseRun
}

/**
 * The daemon's one promise-based `execFile` runner.
 *
 * ⛔ Defaults `windowsHide: true` on every call. A daemon running in the background must never
 * flash a console window on the operator's desktop (e.g. during periodic quota probes, git sweeps,
 * or version detection), which steals focus from foreground and full-screen applications.
 *
 * Call sites keep their own timeout, environment and `maxBuffer`: those are properties of the
 * command being run, while the conversion from Node's callback API is not.
 */
export const run = createRun()


