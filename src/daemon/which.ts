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
 */
export function launchable(resolved: string): Launchable {
  const ext = extname(resolved).toLowerCase()
  if (process.platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    return {
      command: process.env.COMSPEC ?? 'cmd.exe',
      // /d skips AutoRun scripts, which would otherwise print into the session's first frame.
      prefixArgs: ['/d', '/s', '/c', resolved]
    }
  }
  return { command: resolved, prefixArgs: [] }
}
