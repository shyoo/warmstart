import type { PastedImage } from './pasteimages.js'

/**
 * What was half-typed into the new-task composer, kept across a navigation.
 *
 * ⛔ **A scratch, not a draft.** A draft is a task: it has a row, an id, a project, and it shows up
 * in the list as work somebody filed and has not sent. Half a sentence and an attachment nobody has
 * decided about yet is none of those things, and auto-filing it would put rows in the fleet's own
 * table that no operator ever asked to create. This is the other thing — the text still in the box,
 * remembered by the box.
 *
 * ⚠️ It exists because the composer unmounts. Opening a task replaces the list it sits under, and
 * the prompt, the prerequisites and the schedule went with it; somebody who looked something up
 * mid-sentence came back to an empty form.
 *
 * ⭐ **Scoped, because there is more than one composer.** A project's composer files into that
 * project and the fleet-wide one does not, so what was typed into one must not appear in the other.
 * The scope is the project the form is fixed to, or `''` for the fleet-wide form.
 *
 * ⛔ **No preview bytes.** A restored attachment keeps its id — which is the only part the daemon is
 * ever handed — and loses its thumbnail. One downscaled screenshot is over a megabyte of base64 and
 * `localStorage` holds about five in total, so persisting previews would evict the prompt itself,
 * which is the thing anybody actually wanted back. The chip names the attachment instead.
 *
 * ⚠️ Guarded in both directions like every other preference here: `localStorage` throws rather than
 * returning null in real configurations, and a scratch is never worth a blank screen.
 */

const KEY = 'multi_agent_controller.composerScratch'

/** When the task may start, as offered on the clock beside Send. */
export const SCHEDULE_OPTIONS = ['now', '30m', '1h', '2h', '4h', 'custom'] as const
export type ScheduleOption = (typeof SCHEDULE_OPTIONS)[number]

/** An upload that has already happened, minus the bytes needed to draw it. */
export interface ScratchAttachment {
  id: string
  name?: string
  width: number
  height: number
  bytes: number
}

export interface ComposerScratch {
  prompt: string
  /** Prerequisite task ids. ⚠️ Kept: a prerequisite is as much a decision as the prompt is. */
  dependsOn: string[]
  schedule: ScheduleOption
  /** The `datetime-local` value, only meaningful while `schedule` is `custom`. */
  customTime: string
  attachments: ScratchAttachment[]
}

export const EMPTY_SCRATCH: ComposerScratch = {
  prompt: '',
  dependsOn: [],
  schedule: 'now',
  customTime: '',
  attachments: []
}

/**
 * Is there anything here worth coming back to?
 *
 * ⛔ The schedule alone does not count. It is remembered so that a form left armed comes back armed,
 * but a composer whose only content is `now` and a blank prompt is an empty composer, and storing
 * one would mean every visit to the Tasks page wrote to disk.
 */
export function isEmptyScratch(scratch: ComposerScratch): boolean {
  return (
    scratch.prompt.trim().length === 0 &&
    scratch.dependsOn.length === 0 &&
    scratch.attachments.length === 0 &&
    scratch.schedule === 'now' &&
    scratch.customTime === ''
  )
}

/**
 * Anything at all → a scratch this form can be seeded from.
 *
 * ⛔ Field by field, never all-or-nothing. What is stored here was written by an older build of the
 * composer as often as by this one, and losing a paragraph somebody typed because a field that did
 * not exist yet is missing is exactly the failure this module was added to prevent.
 */
export function normalizeScratch(raw: unknown): ComposerScratch {
  if (!raw || typeof raw !== 'object') return EMPTY_SCRATCH
  const held = raw as Record<string, unknown>
  const schedule = SCHEDULE_OPTIONS.find((o) => o === held.schedule) ?? 'now'
  return {
    prompt: typeof held.prompt === 'string' ? held.prompt : '',
    dependsOn: Array.isArray(held.dependsOn)
      ? held.dependsOn.filter((id): id is string => typeof id === 'string')
      : [],
    schedule,
    // ⚠️ Dropped unless the clock is actually on `custom`, so a stale moment cannot be revived by a
    // later change of schedule into a time that has long since passed.
    customTime: schedule === 'custom' && typeof held.customTime === 'string' ? held.customTime : '',
    attachments: Array.isArray(held.attachments)
      ? held.attachments.flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return []
          const a = entry as Record<string, unknown>
          if (typeof a.id !== 'string' || !a.id) return []
          return [
            {
              id: a.id,
              ...(typeof a.name === 'string' ? { name: a.name } : {}),
              width: typeof a.width === 'number' ? a.width : 0,
              height: typeof a.height === 'number' ? a.height : 0,
              bytes: typeof a.bytes === 'number' ? a.bytes : 0
            }
          ]
        })
      : []
  }
}

export function readComposerScratch(scope: string): ComposerScratch {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return EMPTY_SCRATCH
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return EMPTY_SCRATCH
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_SCRATCH
    return normalizeScratch((parsed as Record<string, unknown>)[scope])
  } catch {
    return EMPTY_SCRATCH
  }
}

/**
 * ⚠️ An empty scratch **removes** its scope rather than storing a row of blanks, so a form that was
 * cleared or sent leaves nothing behind for the next one to be seeded from.
 */
export function writeComposerScratch(scope: string, scratch: ComposerScratch): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    const raw = window.localStorage.getItem(KEY)
    let held: Record<string, unknown> = {}
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') held = parsed as Record<string, unknown>
    }
    if (isEmptyScratch(scratch)) delete held[scope]
    else held[scope] = scratch
    window.localStorage.setItem(KEY, JSON.stringify(held))
  } catch {
    // A scratch that cannot be saved is not an error worth showing anybody.
  }
}

/**
 * The attachments of a restored scratch, as the chips strip wants them.
 *
 * ⚠️ `preview` is null and the name carries the loss: an image comes back as `1568×880 image`
 * rather than as a thumbnail. It is still the same upload, and it is still what gets sent.
 */
export function scratchImages(scratch: ComposerScratch): PastedImage[] {
  return scratch.attachments.map((a) => ({
    id: a.id,
    preview: null,
    name: a.name ?? (a.width && a.height ? `${a.width}×${a.height} image` : 'attachment'),
    width: a.width,
    height: a.height,
    bytes: a.bytes
  }))
}

/** The other direction: what is in the composer now, minus the bytes that must not be stored. */
export function scratchAttachments(images: PastedImage[]): ScratchAttachment[] {
  return images.map((image) => ({
    id: image.id,
    ...(image.name ? { name: image.name } : {}),
    width: image.width,
    height: image.height,
    bytes: image.bytes
  }))
}

/**
 * Is there a scratch for this scope worth reopening the composer for?
 *
 * ⛔ The form is collapsed behind a button, so remembering what was typed into it is only half the
 * fix: a scratch nobody can see is the same as no scratch at all. This is what lets the list decide
 * to open the composer already filled in, and it is the only reason `isEmptyScratch` is strict about
 * what counts as content.
 */
export function hasComposerScratch(scope: string): boolean {
  return !isEmptyScratch(readComposerScratch(scope))
}

/** Forget what was typed here — Cancel, and after a send. */
export function clearComposerScratch(scope: string): void {
  writeComposerScratch(scope, EMPTY_SCRATCH)
}
