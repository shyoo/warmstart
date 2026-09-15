import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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

  const dirs = augmentPath(process.env.PATH).split(delimiter).filter(Boolean)

  for (const dir of dirs) {
    for (const ext of pathext) {
      const candidate = join(dir, command + ext)
      try {
        if (!statSync(candidate).isFile()) continue
        if (process.platform !== 'win32') accessSync(candidate, constants.X_OK)
        if (process.platform === 'darwin' && dir === '/usr/bin' && (command === 'git' || command === 'xcrun')) {
          try {
            execFileSync(candidate, ['--version'], { stdio: 'ignore' })
          } catch {
            continue
          }
        }
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

/**
 * Quote an argument for Windows command line processing (CommandLineToArgvW algorithm).
 */
export function quoteCmdArg(arg: string): string {
  if (!arg) return '""'
  if (!/[\s"\\]/.test(arg)) return arg
  let s = '"'
  for (let i = 0; i < arg.length; i++) {
    let bs = 0
    while (i < arg.length && arg[i] === '\\') {
      bs++
      i++
    }
    if (i === arg.length) {
      s += '\\'.repeat(bs * 2)
      break
    } else if (arg[i] === '"') {
      s += '\\'.repeat(bs * 2 + 1) + '"'
    } else {
      s += '\\'.repeat(bs) + arg[i]
    }
  }
  return s + '"'
}

/**
 * Format command and arguments when invoking Windows cmd.exe /c to prevent cmd.exe from
 * stripping quotes when arguments contain spaces.
 *
 * ⛔ cmd.exe /c strips the leading and trailing quote character if there are multiple quoted
 * arguments unless the entire remainder after /c is wrapped in an outer pair of quotes and /s is passed.
 * Node's child_process requires windowsVerbatimArguments: true to avoid re-escaping those outer quotes.
 */
export function formatCmdInvocation(
  command: string,
  args: string[]
): { command: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (process.platform !== 'win32') return { command, args }
  const lower = command.toLowerCase()
  if (!lower.endsWith('cmd.exe') && !lower.endsWith('cmd')) return { command, args }

  const cIdx = args.findIndex((a) => {
    const s = a.toLowerCase()
    return s === '/c' || s === '/k'
  })
  if (cIdx === -1) return { command, args }

  const before = args.slice(0, cIdx)
  const cmdSwitch = args[cIdx]!
  const cmdAndArgs = args.slice(cIdx + 1)
  if (cmdAndArgs.length === 0) return { command, args }

  const fullCommandLine = cmdAndArgs.map(quoteCmdArg).join(' ')
  return {
    command,
    args: [...before.filter((a) => a.toLowerCase() !== '/s'), '/s', cmdSwitch, `"${fullCommandLine}"`],
    windowsVerbatimArguments: true
  }
}

/**
 * For node-pty on Windows, node-pty uses CreateProcessW directly which natively supports
 * batch files (.cmd, .bat). Passing cmd.exe to node-pty with quoted arguments causes cmd.exe
 * quote stripping issues, so unwrapping to the direct batch file target is safer and cleaner.
 * Non-batch commands (including shell builtins like `echo`) must remain under cmd.exe.
 */
export function unwrapForPty(
  command: string,
  args: string[]
): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args }
  const lower = command.toLowerCase()
  if (!lower.endsWith('cmd.exe') && !lower.endsWith('cmd')) return { command, args }

  const cIdx = args.findIndex((a) => {
    const s = a.toLowerCase()
    return s === '/c' || s === '/k'
  })
  if (cIdx === -1) return { command, args }

  const cmdAndArgs = args.slice(cIdx + 1)
  if (cmdAndArgs.length === 0) return { command, args }
  const rawTarget = cmdAndArgs[0]!
  const target = rawTarget.replace(/^["']|["']$/g, '')
  const ext = extname(target).toLowerCase()
  if (ext !== '.cmd' && ext !== '.bat') return { command, args }
  return {
    command: target,
    args: cmdAndArgs.slice(1)
  }
}

/**
 * Variables a spawned agent CLI must never inherit from whatever launched the daemon.
 *
 * ⛔ **An isolation root that inherits the host's session identity is not isolated.** Measured
 * 2026-08-30: a Claude Code session's environment carries around twenty `CLAUDE*` variables,
 * including `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
 * `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_BRIDGE_SESSION_ID` and `CLAUDECODE=1`. Every adapter
 * built its environment by copying `process.env` wholesale and deleting three or four API keys, so a
 * daemon started from inside such a session would hand each worker the operator's own session
 * handle, messaging socket and bridge id — on an account it was not commissioned with.
 *
 * ⚠️ `CLAUDE_CONFIG_DIR` and `CODEX_HOME` match this pattern and are stripped here too. That is
 * correct and deliberate: they are set by the adapter **after** this runs, to the isolation root the
 * worker was commissioned with, and a value inherited from the host is the exact bug — the worker
 * would read the operator's credentials rather than its own.
 */
const HOST_SESSION = /^(CLAUDE|ANTHROPIC_)/i

/**
 * Augment a PATH string on POSIX platforms so user/Homebrew bin directories are searched first.
 *
 * ⛔ macOS GUI launches inherit a minimal system PATH (/usr/bin:/bin:/usr/sbin:/sbin) from launchd.
 * User-installed and package-manager binaries (Homebrew, ~/.local/bin, etc.) are missing from that
 * environment unless explicitly prepended.
 */
export function augmentPath(envPath?: string): string {
  const dirs = (envPath ?? '').split(delimiter).filter(Boolean)
  if (process.platform !== 'win32') {
    const extraDirs = [
      join(homedir(), '.local', 'bin'),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin'
    ]
    const prepend = extraDirs.filter((d) => !dirs.includes(d) && existsSync(d))
    if (prepend.length > 0) {
      dirs.unshift(...prepend)
    }
  }
  return dirs.join(delimiter)
}

/**
 * The key `PATH` is spelled under in a plain environment object — and on Windows that is `Path`.
 *
 * ⛔ **Measured 2026-09-14, a process started from Explorer or `cmd`: the block holds `Path`, not
 * `PATH`.** Node's `process.env` hides this (a read of `process.env.PATH` finds `Path`), but a copy
 * made with `Object.entries` is an ordinary object, and `env.PATH` on it is `undefined`. The first
 * cut of `augmentPath` did `env.PATH = augmentPath(env.PATH)` on such a copy — `PATH=''` beside the
 * real `Path` — and the child was handed **an empty PATH**: libuv keeps one of two keys that differ
 * only in case, and it kept the empty one. `cmd.exe` was then `ENOENT` to every spawn. The installed
 * app was spared by accident — main re-spells it `PATH` when it starts orchestratord — and a daemon
 * started any other way was not. `PATH` is answered when no key is there, and always off Windows.
 */
export function pathKey(env: Record<string, string | undefined>): string {
  if (process.platform !== 'win32') return 'PATH'
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
}

/** `env` with its search path augmented **under the key it already uses**; see `pathKey`. */
export function withAugmentedPath<T extends Record<string, string | undefined>>(env: T): T {
  const key = pathKey(env) as keyof T
  return { ...env, [key]: augmentPath(env[key]) }
}

/**
 * The base environment for any spawned agent CLI.
 *
 * ⛔ A deny by **prefix**, not a whitelist of what to keep, and the choice is deliberate. A whitelist
 * would have to enumerate everything a CLI needs on three platforms — on Windows alone `SystemRoot`,
 * `ComSpec`, `PATHEXT`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `PROCESSOR_ARCHITECTURE` and a dozen more
 * — and one omission is a spawn that fails in a way nobody can trace. Denying a vendor namespace is
 * the opposite trade: the OS environment passes through untouched, and a variable the vendor adds
 * next month is denied before anybody has heard of it.
 *
 * ⚠️ Each adapter still deletes its **own** provider's API keys afterwards. Those are a different
 * rule — a key in the environment silently outranks the subscription a worker was commissioned with
 * and bills somewhere else — and they are kept where the adapter that knows about them lives.
 */
export function spawnEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || HOST_SESSION.test(key)) continue
    env[key] = value
  }
  // ⛔ Under whichever key is there, never a second one: see `pathKey`.
  return withAugmentedPath(env)
}
