/**
 * How a daemon on this machine starts a CLI that needs more than `command args…` to begin a turn.
 *
 * ⛔ **One place, so an adapter never asks what platform it is on.** `hostAt()` names the host,
 * `hostPlan()` produces the command either way, and `muse-code.ts` mentions neither `win32` nor a
 * shell.
 *
 * ⛔ **There is no WSL bridge any more (t547, 2026-09-19).** Muse Code used to ship for Linux and
 * macOS only, so on Windows this module reached a copy installed inside a WSL distribution through
 * `wsl.exe -- bash -lc <script>` — with path translation, `GIT_DIR` exports for Windows-made
 * worktrees, and an image gate for a 9p data home that could never be `0700`. Muse Code 1.3.0 ships a
 * native Windows build (`irm https://dev.meta.ai/install.ps1 | iex`), measured end to end on
 * 2026-09-19, and every one of those workarounds went with the bridge. The history is in git.
 *
 * What remains is the one trick every platform needs:
 *
 *  ⛔ **Some CLIs have no stdin prompt channel at all.** `muse exec` answers `missing prompt` to a
 *  piped prompt, and on Windows `--prompt-file -` is *The system cannot find the file specified* —
 *  both measured. `stdin.path` drains stdin into a file first, which turns the EOF the `once`
 *  transport already sends into the go signal — so nothing in the scheduler changes.
 */

export type CliHost =
  /** macOS or Linux: started through `/bin/sh -c`, which drains stdin with `cat` and then `exec`s. */
  | { kind: 'posix'; path: string }
  /** Windows: the executable itself, and a Node drain in front of it when stdin has to become a file. */
  | { kind: 'windows'; path: string }

export interface StdinCapture {
  /** Where to put what arrives on stdin. */
  path: string
}

export interface HostRequest {
  /** The executable, as resolved on this machine. */
  command: string
  args: string[]
  /** Variables the command needs on top of the spawn environment. */
  env: Record<string, string>
  stdin?: StdinCapture
}

export interface HostPlan {
  command: string
  args: string[]
  /** Variables to add to the spawn environment. Empty on POSIX, where the script exports them. */
  env: Record<string, string>
}

/** The host a resolved executable runs on, which is this machine's own platform. */
export function hostAt(path: string, platform: NodeJS.Platform = process.platform): CliHost {
  return platform === 'win32' ? { kind: 'windows', path } : { kind: 'posix', path }
}

/**
 * One argument, safe inside a POSIX shell script.
 *
 * ⛔ Single quotes and nothing else. A double-quoted string still expands `$`, and a path this app
 * generates can contain one. The `'\''` dance is the only escape a single-quoted string has.
 */
export function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
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

/**
 * The Windows half of `cat > file; exec cmd`, as a Node one-liner: `argv` is `[file, exe, ...args]`.
 *
 * ⛔ **Node, not PowerShell or `cmd`.** `cmd /d /s /c` splits a path with a space (a user profile
 * named for its owner commonly has one), and PowerShell re-encodes a native command's stdout through its OEM
 * code page, which would mangle every non-ASCII byte of the `--json` stream. Node spawns the child
 * with `stdio: 'inherit'`, so the pipe the daemon reads *is* the agent's, byte for byte, and the
 * arguments travel as an array with no quoting of ours. It is the daemon's own runtime
 * (`process.execPath` under `ELECTRON_RUN_AS_NODE`), so nothing has to be installed.
 *
 * ⛔ `ELECTRON_RUN_AS_NODE` is removed before the agent starts. It is inherited by every shell the
 * agent opens, and an `npm test` there that launches Electron would get a Node instead.
 *
 * ⚠️ The daemon holds the wrapper's pid, not the agent's. That is safe because every stop is a
 * `taskkill /T` of the tree (`killProcessTree`), and the wrapper's command line carries the same
 * `--session-id` the orphan reaper proves ownership by.
 */
export const WINDOWS_DRAIN =
  "const fs=require('fs'),cp=require('child_process');" +
  'const [file,exe,...args]=process.argv.slice(1);' +
  'const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;' +
  'const chunks=[];' +
  "process.stdin.on('data',(c)=>chunks.push(c));" +
  "process.stdin.on('end',()=>{" +
  'fs.writeFileSync(file,Buffer.concat(chunks));' +
  "const child=cp.spawn(exe,args,{stdio:'inherit',env,windowsHide:true});" +
  "child.on('error',(e)=>{process.stderr.write(String(e)+'\\n');process.exit(1)});" +
  "child.on('exit',(code)=>process.exit(code===null?1:code))" +
  '})'

/** Everything needed to start `req` on `host`, as something `pty.spawn`/`child_process` can take. */
export function hostPlan(host: CliHost, req: HostRequest): HostPlan {
  if (host.kind === 'posix') return { command: '/bin/sh', args: ['-c', hostScript(req)], env: {} }
  if (!req.stdin) return { command: req.command, args: req.args, env: req.env }
  return {
    command: process.execPath,
    args: ['-e', WINDOWS_DRAIN, req.stdin.path, req.command, ...req.args],
    env: { ...req.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}
