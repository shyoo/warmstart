import { spawn } from 'node:child_process'
import type { Task } from '../shared/tasks.js'
import type { Session } from '../shared/protocol.js'
import { sessionEnded } from '../shared/protocol.js'
import type { PowerAction, PowerActionState } from '../shared/ipc.js'

/** A one-shot action belongs to this running app, never to a project or a remote desktop. */
export const POWER_GRACE_MS = 60_000

export function availablePowerActions(platform: NodeJS.Platform): PowerAction[] {
  if (platform === 'win32' || platform === 'linux') return ['shutdown', 'sleep', 'hibernate']
  if (platform === 'darwin') return ['shutdown', 'sleep']
  return []
}

/** Human and quota holds have no work in flight; resource/dependency holds can resume on their own. */
export function hasActiveWork(tasks: readonly Task[], sessions: readonly Session[]): boolean {
  return tasks.some((task) => task.deletedAt === null && [
    'ready', 'blocked', 'scheduled', 'assigned', 'running', 'landing_queued', 'cancelling'
  ].includes(task.status)) || sessions.some((session) =>
    ['work', 'consult', 'review'].includes(session.purpose) && !sessionEnded(session.state))
}

const POWRPROF = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Power { [DllImport("powrprof.dll", SetLastError=true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent); [DllImport("powrprof.dll")] public static extern bool IsPwrHibernateAllowed(); [DllImport("powrprof.dll")] public static extern bool IsPwrSuspendAllowed(); }'`

export function powerCommand(platform: NodeJS.Platform, action: PowerAction): { file: string; args: string[] } | null {
  if (!availablePowerActions(platform).includes(action)) return null
  if (platform === 'win32') {
    if (action === 'shutdown') return { file: 'shutdown.exe', args: ['/s', '/t', '0'] }
    // ⚠️ Not `shutdown /h`: with hibernation disabled it prints "(126)" and exits 0 (measured, Windows 11,
    // 2026-10-21, t1186), so a refusal read as success. SetSuspendState(FALSE) requests sleep;
    // rundll32's no-argument call can hibernate instead.
    const hibernate = action === 'hibernate'
    const allowed = hibernate ? 'IsPwrHibernateAllowed' : 'IsPwrSuspendAllowed'
    const refused = hibernate ? 'Hibernation is not enabled on this computer' : 'Sleep is not available on this computer'
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command',
      `${POWRPROF}; if (-not [Power]::${allowed}()) { [Console]::Error.WriteLine('${refused}'); exit 1 }; if (-not [Power]::SetSuspendState($${hibernate},$false,$false)) { [Console]::Error.WriteLine("SetSuspendState failed with Windows error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"); exit 1 }`] }
  }
  if (platform === 'darwin') return action === 'sleep'
    ? { file: 'pmset', args: ['sleepnow'] }
    : { file: 'osascript', args: ['-e', 'tell application "System Events" to shut down'] }
  return { file: 'systemctl', args: [action === 'shutdown' ? 'poweroff' : action === 'sleep' ? 'suspend' : 'hibernate'] }
}

/**
 * Windows can refuse sleep or hibernate (hibernation off by default on many desktops), so the menu
 * asks powrprof rather than offering what the platform could do. Null means unread: offer the
 * platform list and let the command's own refusal say why.
 */
export async function probePowerActions(platform: NodeJS.Platform): Promise<PowerAction[] | null> {
  if (platform !== 'win32') return null
  const output = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `${POWRPROF}; [Console]::Out.Write("sleep=$([Power]::IsPwrSuspendAllowed()) hibernate=$([Power]::IsPwrHibernateAllowed())")`])
  if (output.code !== 0) return null
  return parsePowerProbe(output.text)
}

export function parsePowerProbe(text: string): PowerAction[] | null {
  const match = /sleep=(True|False) hibernate=(True|False)/.exec(text)
  if (!match) return null
  return ['shutdown', ...(match[1] === 'True' ? ['sleep' as const] : []), ...(match[2] === 'True' ? ['hibernate' as const] : [])]
}

function capture(file: string, args: string[]): Promise<{ code: number | null; text: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let text = ''
    const append = (chunk: Buffer): void => { if (text.length < 4_000) text += chunk.toString() }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, text: text.trim() }))
  })
}

/**
 * Says which action failed and what the OS said. `shutdown.exe` reports a refusal as a sentence
 * ending in the Windows error number, e.g. "(1190)" for a shutdown already scheduled, and some of
 * those refusals exit 0 — so that suffix is a failure whatever the exit code.
 */
export function powerFailure(action: PowerAction, file: string, code: number | null, text: string): string | null {
  const windowsError = /\((\d+)\)\s*$/.exec(text)
  if (code === 0 && !windowsError) return null
  const said = text.replace(/\s+/g, ' ').trim()
  return `${POWER_LABEL[action]} failed: ${said || `${file} exited with code ${code}`}`
}

export const POWER_LABEL: Record<PowerAction, string> = { shutdown: 'Shut down', sleep: 'Sleep', hibernate: 'Hibernate' }

export async function runPowerCommand(platform: NodeJS.Platform, action: PowerAction): Promise<void> {
  const command = powerCommand(platform, action)
  if (!command) throw new Error(`${action} is unavailable on this computer`)
  const result = await capture(command.file, command.args)
  const failure = powerFailure(action, command.file, result.code, result.text)
  if (failure) throw new Error(failure)
}

export class PowerActionController {
  private action: PowerAction | null = null
  private dueAt: number | null = null
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private checking = false
  private generation = 0
  private probed: PowerAction[] | null = null

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly activeWork: () => Promise<boolean>,
    private readonly execute: (action: PowerAction) => Promise<void>,
    private readonly changed: (state: PowerActionState) => void,
    private readonly clock: () => number = Date.now
  ) {}

  state(): PowerActionState {
    return { available: this.available(), action: this.action, dueAt: this.dueAt, error: this.error }
  }

  /** What this computer said it can do (`probePowerActions`); never widens the platform list. */
  restrict(actions: readonly PowerAction[]): void {
    this.probed = availablePowerActions(this.platform).filter((action) => actions.includes(action))
    this.changed(this.state())
  }

  private available(): PowerAction[] {
    return this.probed ?? availablePowerActions(this.platform)
  }

  async arm(action: PowerAction): Promise<PowerActionState> {
    if (!this.available().includes(action)) throw new Error(`${action} is unavailable on this computer`)
    const generation = ++this.generation
    // A failed read must never be interpreted as an empty queue.
    if (!await this.activeWork()) throw new Error('No running or queued work to wait for')
    if (generation !== this.generation) return this.state()
    this.action = action
    this.dueAt = null
    this.error = null
    this.changed(this.state())
    if (!this.timer) this.timer = setInterval(() => void this.check(), 5_000)
    return this.state()
  }

  cancel(): PowerActionState {
    this.generation++
    this.action = null
    this.dueAt = null
    this.error = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.changed(this.state())
    return this.state()
  }

  async check(): Promise<void> {
    if (!this.action || this.checking) return
    this.checking = true
    const generation = this.generation
    try {
      const active = await this.activeWork()
      if (generation !== this.generation) return
      if (active) {
        if (this.dueAt !== null) {
          this.dueAt = null
          this.changed(this.state())
        }
        return
      }
      if (this.dueAt === null) {
        this.dueAt = this.clock() + POWER_GRACE_MS
        this.changed(this.state())
        return
      }
      if (this.clock() < this.dueAt) return
      // Read once more at the action boundary, after the countdown and any queued event.
      if (await this.activeWork() || generation !== this.generation) {
        if (generation === this.generation) {
          this.dueAt = null
          this.changed(this.state())
        }
        return
      }
      const action = this.action
      this.cancel()
      try {
        await this.execute(action)
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error)
        this.changed(this.state())
      }
    } catch (error) {
      if (generation === this.generation) {
        this.cancel()
        this.error = error instanceof Error ? error.message : String(error)
        this.changed(this.state())
      }
    } finally {
      this.checking = false
    }
  }

  dispose(): void { this.cancel() }
}
