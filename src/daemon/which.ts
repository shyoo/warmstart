import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join } from 'node:path'

/**
 * Resolve a command to something a PTY can actually start.
 *
 * ⚠️ node-pty does not search PATH. On Windows it goes straight to CreateProcess, which fails with a
 * bare "File not found" for a command that runs perfectly in a shell - a confusing failure that
 * looks like the CLI is not installed when it is. Measured 2026-08-25.
 *
 * `execFile` with `shell: true` hides this, which is why detection can succeed while spawning fails.
 * Both paths go through here now so they agree.
 */
export function which(command: string): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null

  const pathext =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']

  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of pathext) {
      const candidate = join(dir, command + ext)
      try {
        if (!statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null
}

export interface Launchable {
  command: string
  prefixArgs: string[]
}

/**
 * A `.cmd` or `.bat` shim - what an npm global install leaves on Windows - is a script, not an
 * image, so it has to go through the command processor. A real executable is started directly.
 *
 * ⚠️ This applies to **every** way agentyard starts a CLI, not just PTY spawns. Node refuses to
 * `execFile` a `.cmd` without a shell (it has since the 2024 argument-injection fix) and fails with a
 * bare `spawn EINVAL`. Measured 2026-08-25: `codex` installs as `codex.cmd`, and adapter *detection*
 * - which is `execFile`, not node-pty - failed with exactly that while the CLI itself worked
 * perfectly. Detection that fails for an installed CLI reports it as missing, which sends somebody to
 * reinstall something they already have.
 */
export function launchable(resolved: string): Launchable {
  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return {
      command: process.env.COMSPEC ?? 'cmd.exe',
      // ⛔ `/d` only. `/s` was here and was actively wrong: it makes cmd strip the outer quotes and
      // take the rest literally, so an unquoted path containing a space is split at the space — and
      // the Windows default home is `C:\Users\First Last`. Measured 2026-08-25 against `codex.CMD`:
      // with `/s` every invocation failed; without it, it works. `/d` stays, because it skips
      // AutoRun scripts that would otherwise print into the session's first frame.
      //
      // ⚠️ Do not add quotes around `resolved` either — Node quotes an argument containing spaces
      // when it builds the command line, and a second layer breaks it again. Measured the same day.
      prefixArgs: ['/d', '/c', resolved]
    }
  }
  return { command: resolved, prefixArgs: [] }
}

/**
 * Everything needed to run a resolved command once, whatever kind of file it turned out to be.
 * ⛔ Use this rather than calling `execFile(resolved, args)` directly - see the note on `launchable`.
 */
export function launchArgs(resolved: string, args: string[]): { command: string; args: string[] } {
  const { command, prefixArgs } = launchable(resolved)
  return { command, args: [...prefixArgs, ...args] }
}
