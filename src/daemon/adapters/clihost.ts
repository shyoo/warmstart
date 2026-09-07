import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { which } from '../which.js'

/**
 * Where an agent CLI actually runs, and how a daemon on this machine reaches it.
 *
 * ⛔ **One place, so an adapter never asks what platform it is on.** Muse Code ships for Linux and
 * macOS; on Windows the operator installs it inside a WSL distribution and there is no Windows
 * binary to put on `PATH`. Without this module every adapter wrapping a Linux-only CLI would grow
 * its own copy of the same five workarounds, and the macOS build would carry Windows code it can
 * never execute. `hostFor()` answers *native or bridged*, `hostPlan()` produces the command either
 * way, and `muse-code.ts` mentions neither WSL nor `win32`.
 *
 * Five things were measured on 2026-09-06 and each one changes the shape of the command:
 *
 *  1. ⛔ **`wsl.exe -- bash -lc <script> arg…` silently drops the trailing positional arguments.**
 *     A script printing `$#` came back `0`, with `$0` reading `/bin/bash` — so the `$1`/`$2`
 *     convention that would normally keep paths out of the script text does not survive the hop.
 *     Every path is therefore **quoted into the script** by `shQuote`, which is why that is an
 *     exported, tested function rather than an inline template.
 *  2. ⛔ **WSL inherits nothing from the Windows environment.** Variables have to be `export`ed
 *     inside the script; the env handed to `child_process` reaches `wsl.exe` and stops there.
 *  3. ⛔ **A Windows-made git worktree is unreadable by WSL git.** `<worktree>/.git` is a file
 *     holding `gitdir: C:/Dev/…`, which git inside the distribution resolves *relatively*:
 *     `fatal: not a git repository: /mnt/c/…/ws1/C:/Dev/…`. Since every workspace this app hands out
 *     is such a worktree, a bridged agent could not run one git command. `gitEnvFor()` fixes it with
 *     `GIT_DIR`/`GIT_WORK_TREE` and **modifies no file** — measured working, and needing no
 *     `safe.directory`.
 *  4. ⚠️ **A Linux CLI cannot be handed a Windows path.** `hostPath` is the translation, and every
 *     path crossing the boundary — cwd, isolation root, attachments, the prompt file — goes through
 *     it. On a native host it is the identity function.
 *  5. ⛔ **Some CLIs have no stdin prompt channel at all.** `muse exec` answers `missing prompt` to a
 *     piped prompt. `stdin.path` drains stdin into a file first, which turns the EOF the `once`
 *     transport already sends into the go signal — so nothing in the scheduler changes. That trick
 *     is needed on **every** platform, which is why it lives here beside the shell script and not in
 *     the WSL half.
 */

export type CliHost =
  /** The binary is on this machine's own `PATH`. */
  | { kind: 'native'; path: string }
  /** The binary lives inside a WSL distribution and is reached through `wsl.exe`. */
  | { kind: 'wsl'; wsl: string }

export interface StdinCapture {
  /** Where to put what arrives on stdin, as a path **on the host's side of the boundary**. */
  path: string
}

export interface HostRequest {
  /** The command as it is spelled where it runs, e.g. `muse`. */
  command: string
  args: string[]
  /** The working directory, as a path on **this** machine. */
  cwd: string
  /** Variables the command needs, with values already translated by `hostPath` where they are paths. */
  env: Record<string, string>
  stdin?: StdinCapture
}

export interface HostPlan {
  command: string
  args: string[]
}

/**
 * Where `wsl.exe` is, or null on a machine that has none.
 *
 * ⚠️ Resolved off `SystemRoot` rather than hard-coded, because the Windows directory is not always
 * `C:\Windows` — and never off `PATH`, where a `wsl` could be anything.
 */
export function wslExecutable(): string | null {
  if (process.platform !== 'win32') return null
  const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
  const exe = join(root, 'System32', 'wsl.exe')
  return existsSync(exe) ? exe : null
}

/**
 * How this machine can reach `command`, or null if it cannot.
 *
 * ⛔ Native wins. An operator who has installed the CLI natively — which is every macOS and Linux
 * install, and a Windows one the vendor may ship later — must not be quietly routed through a
 * virtual machine they did not ask for.
 */
export function hostFor(command: string): CliHost | null {
  const native = which(command)
  if (native) return { kind: 'native', path: native }
  const wsl = wslExecutable()
  return wsl ? { kind: 'wsl', wsl } : null
}

/**
 * `C:\Dev\x y` → `/mnt/c/Dev/x y` for a bridged host; unchanged for a native one.
 *
 * ⚠️ A path already inside the distribution is returned untouched, so translating twice is safe.
 * ⛔ A UNC path throws rather than being mangled into something that would silently point elsewhere.
 */
export function hostPath(host: CliHost, path: string): string {
  if (host.kind === 'native') return path
  if (path.startsWith('/')) return path
  if (path.startsWith('\\\\')) {
    throw new Error(`a UNC path cannot be reached from inside WSL: ${path}`)
  }
  const drive = /^([A-Za-z]):[\\/]?(.*)$/.exec(path)
  if (!drive) return path.split('\\').join('/')
  const rest = (drive[2] ?? '').split('\\').join('/')
  return `/mnt/${(drive[1] ?? '').toLowerCase()}${rest ? `/${rest}` : ''}`
}

/**
 * One argument, safe inside a POSIX shell script.
 *
 * ⛔ Single quotes and nothing else. A double-quoted string still expands `$`, and a path this app
 * generates can contain one — `$RECYCLE.BIN` sits at the root of every Windows volume. The `'\''`
 * dance is the only escape a single-quoted string has.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/**
 * The environment a git inside the distribution needs so a Windows-made worktree works.
 *
 * ⛔ Returns `{}` for an ordinary clone — where `.git` is a directory already inside the workspace
 * and nothing is broken — and for a directory that is no repository at all.
 *
 * ⚠️ `GIT_DIR` is sticky: an agent that changes directory into a *different* repository is still
 * talking to this one. That is the accepted cost and it is the smaller one. The alternative is
 * rewriting the vendor's `.git` pointer to a `/mnt/c` path, which would break the Windows side that
 * runs the project's checks and does the landing — the two have to agree, and only one of them can
 * be right about the spelling.
 */
export function gitEnvFor(host: CliHost, cwd: string): Record<string, string> {
  if (host.kind === 'native') return {}
  try {
    const dotGit = join(cwd, '.git')
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return {}
    const pointer = readFileSync(dotGit, 'utf8').trim()
    const match = /^gitdir:\s*(.+)$/m.exec(pointer)
    if (!match?.[1]) return {}
    const gitDir = resolve(cwd, match[1].trim())
    if (!existsSync(gitDir)) return {}
    return { GIT_DIR: hostPath(host, gitDir), GIT_WORK_TREE: hostPath(host, cwd) }
  } catch {
    // A workspace whose git pointer cannot be read is one the agent finds out about itself.
    return {}
  }
}

/**
 * The POSIX script a host runs: export the environment, optionally drain stdin into a file, then
 * `exec` the command.
 *
 * ⛔ `exec`, so the process the daemon holds a handle to **is** the agent. Without it an interrupt
 * and a reap would land on a shell wrapper while the agent carried on holding the account.
 */
export function hostScript(req: HostRequest): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(req.env)) {
    lines.push(`export ${key}=${shQuote(value)}`)
  }
  if (req.stdin) lines.push(`cat > ${shQuote(req.stdin.path)}`)
  lines.push(['exec', shQuote(req.command), ...req.args.map(shQuote)].join(' '))
  return lines.join('\n')
}

/** Everything needed to start `req` on `host`, as something `pty.spawn`/`child_process` can take. */
export function hostPlan(host: CliHost, req: HostRequest): HostPlan {
  const script = hostScript(req)
  if (host.kind === 'native') return { command: '/bin/sh', args: ['-c', script] }
  return {
    command: host.wsl,
    args: ['--cd', hostPath(host, req.cwd), '--', 'bash', '-lc', script]
  }
}

/**
 * Run one command on the host and read its output — the `execFile` half, for version detection.
 *
 * ⚠️ No script and no environment: this is for questions a CLI answers about itself, which must not
 * depend on an isolation root being set up.
 */
export function hostExec(host: CliHost, command: string, args: string[]): HostPlan {
  if (host.kind === 'native') return { command: host.path, args }
  return { command: host.wsl, args: ['--', command, ...args] }
}
