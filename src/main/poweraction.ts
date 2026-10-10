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

export function powerCommand(platform: NodeJS.Platform, action: PowerAction): { file: string; args: string[] } | null {
  if (!availablePowerActions(platform).includes(action)) return null
  if (platform === 'win32') {
    if (action === 'shutdown') return { file: 'shutdown.exe', args: ['/s', '/t', '0'] }
    if (action === 'hibernate') return { file: 'shutdown.exe', args: ['/h'] }
    // SetSuspendState(FALSE) requests sleep; rundll32's no-argument call can hibernate instead.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class Power { [DllImport("powrprof.dll", SetLastError=true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent); }'; if (-not [Power]::SetSuspendState($false,$false,$false)) { exit 1 }`] }
  }
  if (platform === 'darwin') return action === 'sleep'
    ? { file: 'pmset', args: ['sleepnow'] }
    : { file: 'osascript', args: ['-e', 'tell application "System Events" to shut down'] }
  return { file: 'systemctl', args: [action === 'shutdown' ? 'poweroff' : action === 'sleep' ? 'suspend' : 'hibernate'] }
}

export async function runPowerCommand(platform: NodeJS.Platform, action: PowerAction): Promise<void> {
  const command = powerCommand(platform, action)
  if (!command) throw new Error(`${action} is unavailable on this computer`)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command.file} exited with code ${code}`)))
  })
}

export class PowerActionController {
  private action: PowerAction | null = null
  private dueAt: number | null = null
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private checking = false
  private generation = 0

  constructor(
    private readonly platform: NodeJS.Platform,
    private readonly activeWork: () => Promise<boolean>,
    private readonly execute: (action: PowerAction) => Promise<void>,
    private readonly changed: (state: PowerActionState) => void,
    private readonly clock: () => number = Date.now
  ) {}

  state(): PowerActionState {
    return { available: availablePowerActions(this.platform), action: this.action, dueAt: this.dueAt, error: this.error }
  }

  async arm(action: PowerAction): Promise<PowerActionState> {
    if (!availablePowerActions(this.platform).includes(action)) throw new Error(`${action} is unavailable on this computer`)
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
