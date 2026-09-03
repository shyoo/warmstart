import React, { useCallback, useRef, useState } from 'react'
import { rpc } from './daemon.js'

/**
 * Pasting, dropping, and selecting attachments in a composer.
 *
 * ⛔ **Downscaled in the renderer, before a byte leaves it.** The vendor's own recommendation is
 * 1568px on the longest edge, and for a full-screen grab that is the difference between roughly 1.1k
 * and 4k input tokens on every run that carries it — paid again on each re-delivery after a
 * preemption. A screenshot is also the one attachment nobody ever needs at native resolution.
 *
 * ⛔ **One image per upload call.** `MAX_BODY_BYTES` on the daemon is 4 MB and stays 4 MB; eight
 * pasted screenshots are eight requests of ~2 MB rather than one of 16.
 */

/** The longest edge we will send. The vendor's own number, not a guess. */
export const MAX_EDGE = 1568

/** Per message, matching the daemon's own limit so the refusal happens where somebody can read it. */
export const MAX_ATTACHMENTS = 8
/** @deprecated Use MAX_ATTACHMENTS; retained for existing image-only callers. */
export const MAX_IMAGES = MAX_ATTACHMENTS

export interface PastedImage {
  /** The attachment row's id, which is what `task.create` and `task.message` are given. */
  id: string
  /** A `data:` URL of the downscaled bytes, for the chip. Never round-trips to the daemon. */
  preview: string | null
  name?: string
  width: number
  height: number
  bytes: number
}

/**
 * Shrink to `MAX_EDGE` on the longest side and re-encode as PNG.
 *
 * ⚠️ Always PNG, whatever came in. A screenshot is flat colour and text, where PNG is both smaller
 * and sharper than a re-encoded JPEG, and one output format means one magic number for the daemon to
 * check. An image already inside the limit is still re-encoded, which is what strips whatever
 * metadata the source put on it.
 */
async function downscale(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('this window cannot draw to a canvas, so an image cannot be resized')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) throw new Error('the image could not be re-encoded')
    return { blob, width, height }
  } finally {
    bitmap.close()
  }
}

export function toBase64(bytes: ArrayBuffer): string {
  // ⚠️ In chunks. `String.fromCharCode(...huge)` overflows the argument list on a megabyte of
  // pixels — exactly the size these are — and fails as a RangeError nobody would connect to having
  // pasted a screenshot.
  const view = new Uint8Array(bytes)
  let binary = ''
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export interface PasteImages {
  images: PastedImage[]
  /** Null unless the last attempt failed. Shown next to the composer, never swallowed. */
  error: string | null
  busy: boolean
  accept: (files: File[]) => Promise<void>
  /** Wire to `onPaste` on the textarea. */
  onPaste: (e: React.ClipboardEvent) => void
  /** Wire to `onDrop`. `onDragOver` must call `preventDefault` or the drop never fires. */
  onDrop: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  addFiles: (files: File[]) => Promise<void>
  addFolders: () => Promise<void>
  remove: (id: string) => void
  /** After a successful submit. Does not delete the uploads — the message now owns them. */
  clear: () => void
  /** What to hand `task.create` / `task.message`. */
  ids: string[]
}

/**
 * ⚠️ Uploaded on paste, not on submit. The upload is what turns clipboard bytes into an id, and an
 * id is the only thing the two forms can carry; doing it at submit time would put a visible pause
 * between pressing the button and the task existing. An upload whose form is then abandoned is
 * collected by the daemon's `prunePending`.
 */
export function usePastedImages(): PasteImages {
  const [images, setImages] = useState<PastedImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // ⚠️ A ref alongside the state, because the upload loop is async and `images` in its closure is
  // whatever it was when the paste started. The cap has to be counted against what is really there.
  const count = useRef(0)

  const accept = useCallback(async (files: File[]) => {
    const pictures = files.filter((f) => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    setError(null)
    setBusy(true)
    try {
      for (const file of pictures) {
        if (count.current >= MAX_ATTACHMENTS) {
          setError(`${MAX_ATTACHMENTS} attachments is the limit for one message`)
          break
        }
        const { blob, width, height } = await downscale(file)
        const dataBase64 = toBase64(await blob.arrayBuffer())
        const attachment = await rpc('attachment.create', {
          dataBase64,
          mediaType: 'image/png',
          width,
          height
        })
        count.current += 1
        setImages((current) => [
          ...current,
          {
            id: attachment.id,
            preview: `data:image/png;base64,${dataBase64}`,
            width,
            height,
            bytes: attachment.bytes
          }
        ])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      // ⛔ `getAsFile()` over items of kind `file`, not `clipboardData.files`. A screenshot copied
      // from a browser or a snipping tool arrives as an item with no entry in `files` on some
      // platforms, which is precisely the paste this exists to catch.
      const items = [...(e.clipboardData?.items ?? [])]
      const files = items
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length === 0) return
      // ⚠️ Only when there is an image. A paste that is text must go on behaving exactly as it did;
      // preventing the default on every paste would break typing into the box.
      e.preventDefault()
      void accept(files)
    },
    [accept]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      e.preventDefault()
      void accept(files)
    },
    [accept]
  )

  const addFiles = useCallback(async (files: File[]) => {
    setError(null)
    setBusy(true)
    try {
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          await accept([file])
          continue
        }
        if (count.current >= MAX_ATTACHMENTS) {
          throw new Error(`${MAX_ATTACHMENTS} attachments is the limit for one message`)
        }
        const attachment = await rpc('attachment.create', {
          dataBase64: toBase64(await file.arrayBuffer()),
          mediaType: file.type || 'application/octet-stream',
          name: file.name
        })
        count.current += 1
        setImages((current) => [...current, { id: attachment.id, preview: null, name: file.name, width: 0, height: 0, bytes: attachment.bytes }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [accept])

  const addFolders = useCallback(async () => {
    setError(null)
    setBusy(true)
    try {
      const paths = await window.agentyard.pickFolders()
      for (const path of paths) {
        if (count.current >= MAX_ATTACHMENTS) {
          throw new Error(`${MAX_ATTACHMENTS} attachments is the limit for one message`)
        }
        const attachment = await rpc('attachment.folder', { path })
        count.current += 1
        setImages((current) => [...current, { id: attachment.id, preview: null, name: path.split(/[/\\]/).pop() ?? path, width: 0, height: 0, bytes: 0 }])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    images,
    error,
    busy,
    accept,
    onPaste,
    onDrop,
    // ⛔ Without this the browser never fires `drop` at all — it treats the textarea as a
    // non-target and opens the file instead, which in Electron replaces the whole window.
    onDragOver: (e) => {
      if ([...(e.dataTransfer?.items ?? [])].some((i) => i.kind === 'file')) e.preventDefault()
    },
    addFiles,
    addFolders,
    remove: (id) =>
      setImages((current) => {
        const next = current.filter((i) => i.id !== id)
        count.current = next.length
        return next
      }),
    clear: () => {
      setImages([])
      setError(null)
      count.current = 0
    },
    ids: images.map((i) => i.id)
  }
}

/** The strip of thumbnails under a composer, each removable before the message is sent. */
export function ImageChips({ paste }: { paste: PasteImages }): React.JSX.Element | null {
  if (paste.images.length === 0 && !paste.error && !paste.busy) return null
  return (
    <div className="chips">
      {paste.images.map((image) => (
        <span className="chip" key={image.id}>
          {image.preview ? <img className="chip-thumb" src={image.preview} alt="" /> : <span className="chip-size dim">{image.name}</span>}
          {image.preview && <span className="chip-size dim">{image.width}×{image.height}</span>}
          <button
            className="chip-x"
            title="Remove this attachment from the message"
            onClick={() => paste.remove(image.id)}
          >
            ×
          </button>
        </span>
      ))}
      {paste.busy && <span className="chip-note dim">Adding…</span>}
      {paste.error && <span className="chip-note chip-note--bad">{paste.error}</span>}
    </div>
  )
}
