import type { DaemonEvent } from '@shared/protocol.js'

/**
 * The daemon's outbound event sink.
 *
 * A mutation is only half done when the row is written: any UI attached - including a second window,
 * or one that opened after the change - has to hear about it. Routing every change through one sink
 * keeps that from depending on which code path made it.
 */
let sink: (event: DaemonEvent) => void = () => {}

export function setEventSink(fn: (event: DaemonEvent) => void): void {
  sink = fn
}

export function emit(event: DaemonEvent): void {
  sink(event)
}
