import type { DaemonEvent } from '@shared/protocol.js'
import { withLanding } from './landingstate.js'

/**
 * The daemon's outbound event sink.
 *
 * A mutation is only half done when the row is written: any UI attached - including a second window,
 * or one that opened after the change - has to hear about it. Routing every change through one sink
 * keeps that from depending on which code path made it.
 *
 * ⛔ Which is also why a task's `landing` flag is set here and not by the caller: two dozen places
 * emit `task.changed`, and a flag each of them had to remember was dropped by every one that did not.
 */
let sink: (event: DaemonEvent) => void = () => {}

export function setEventSink(fn: (event: DaemonEvent) => void): void {
  sink = fn
}

export function emit(event: DaemonEvent): void {
  sink(event.type === 'task.changed' ? { ...event, task: withLanding(event.task) } : event)
}
