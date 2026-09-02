# Pasting an image into a task — survey and implementation plan

**Filed 2026-08-31 (t65).** Survey is measured against the CLIs installed here: claude 2.1.251 ·
agy 1.1.22 · codex 0.151.0. Two design decisions were put to the operator and are recorded in §3.

⭐ **Built 2026-09-01.** §4-§7 are shipped: `imageInput` replaced `multimodalInput`, migration 31
carries the `attachments` table, `promptFor` returns `{ text, attachments }`, and both composers
take a paste. ⚠️ The one deviation from §5.5 is which prompts an image rides on — the plan said
"the messages that travel", which is right, but a *cold* prompt restates the task's own first
message by design, so an image filed with the task goes out on every cold start and is suppressed
only into a conversation that already holds it (`resumed`). §8's R16 and R16b are still owed: no
image has yet reached a real dispatched run, and question answers remain out of scope.

---

## 1. What is true today

`AdapterCapabilities.multimodalInput` exists, is `true` on all three built-in adapters, and is read by
**nothing** — `grep` finds five hits: three declarations, one `external.ts` default, one type. It was
written as an aspiration and never became a mechanism.

Nothing in the pipeline can carry bytes. The chain is text end to end:

```
New Task textarea ─┐
                   ├─► task.create / task.message  (JSON string)
Thread note box  ──┘        │
                            ▼
                     task_messages.text            (sqlite TEXT, no blob, no side table)
                            │
                            ▼
                     promptFor() → string          (scheduler.ts:1920)
                            │
                            ▼
                     sendPrompt(id, text)          (sessions.ts:823)
                            │
                            ▼
                     encodeStreamPrompt(text)      (per adapter)
```

Every one of those five signatures takes or returns a bare `string`, so an image has nowhere to
travel even if one could be pasted.

## 2. What each CLI can actually take — measured 2026-08-31, not read off `--help`

| CLI | Inline over its stream stdin | At spawn | By file path |
|---|---|---|---|
| **claude** 2.1.251 | ⭐ **Yes.** `{"type":"image","source":{"type":"base64","media_type":…,"data":…}}` as a content block inside the existing `{"type":"user",…}` envelope | — | yes (`Read`) |
| **codex** 0.151.0 | ⛔ **No stdin channel at all** — `streamPrompts: 'once'`, stdin is the prompt and then EOF | ⭐ `-i, --image <FILE>...`, *"Optional image(s) to attach to the initial prompt"* | yes |
| **agy** 1.1.22 | ⛔ **Refuses, and kills the turn** | no flag exists | ⭐ yes (`view_file`) |

**The measurements themselves**, so nobody re-derives them:

- **Claude, inline.** A 64×64 PNG of four quadrants — blue, yellow, black, white clockwise from
  top-left — sent as a base64 `image` block through
  `claude -p --input-format stream-json --output-format stream-json --verbose`. Answer:
  `Blue yellow black white.` Exactly right, in order, and the colours are not guessable from the
  text. **The envelope agentyard already sends takes an image block today with no change to its
  shape.**
- **Antigravity, inline.** The same message in agy's `{"event":"user",…}` envelope:

  ```
  "status":"ERROR","num_turns":0,
  "error":"stream input content block type \"image\" is not supported (only \"text\")"
  ```

  ⛔ This is the fact that makes capability-gating mandatory rather than tidy. It is not that the
  image is dropped — **the whole turn fails, zero turns run**, and a run that failed for this reason
  would read as the agent having failed the task.
- **Antigravity, by path.** Same image, prompt naming `C:/Dev/tmp_imgtest/quad.png`. It called
  `view_file` on the `.png` and answered `Blue Yellow Black White`. ⭐ The fallback is real, not
  hopeful.
- **Codex, `-i`.** Attached and reached the model — asked *"without running any command"* it answered
  rather than saying `CANNOT`, so the attachment arrived. ⚠️ It answered **`blue black black blue`**,
  which is wrong. Left to its own devices on the first attempt it shelled out to sample the pixels
  and got it right. Read that as *the channel works, this model's vision on a small synthetic image
  is poor* — an agent-quality fact, not a plumbing one, and one more reason the file path travels
  alongside the attachment on every adapter.

**Conclusion: there is no one channel.** Three CLIs, three answers — exactly the shape of every other
capability here, which is why this becomes data on the adapter rather than an `if`.

## 3. Decisions taken (operator, 2026-08-31)

1. **Surfaces: New Task form + task thread note.** Not question answers. ⚠️ A *live* question is
   answered through an MCP tool result the agent is holding open, and whether Claude Code renders an
   image block in a tool result back to the model is **unmeasured** — see R16b in §8. A parked
   question's answer becomes an ordinary thread message and therefore gets images for free once
   this lands.
2. **Path fallback, and routing is not touched.** Inline where the adapter declares it, `-i` at spawn
   where that is the channel, and **the absolute path named in the prompt text on every adapter,
   including the ones that also got the bytes inline.** ⛔ Attachments do not become a routing term:
   zero of 54 tasks has run on two keys, so a hand-set weight would be exactly the kind of term the
   objective vector exists to avoid.

## 4. The shape

`multimodalInput: boolean` is replaced by how the image is **delivered**, declared per adapter:

```ts
/**
 * How this CLI can be handed an image, if at all.
 *
 *  - `inline`     — a content block in the stream envelope. Claude Code (measured 2026-08-31).
 *  - `spawn-flag` — an argv flag on the process that runs the turn, so **initial prompt only**.
 *                   Codex's `-i/--image`.
 *  - `none`       — no channel. Antigravity, which does not merely ignore an image block, it
 *                   **fails the whole turn** on one.
 *
 * ⛔ The absolute path is written into the prompt text regardless of this value. It costs ~20
 * tokens, every one of the three reads a PNG off disk with its own view tool, and it is what
 * rescues a run whose inline block was dropped by a CLI update nobody here noticed.
 */
imageInput: 'inline' | 'spawn-flag' | 'none'
```

`external.ts` defaults it to `'none'` — a declarative adapter that has not said otherwise must not be
sent bytes that could kill its turn.

**An attachment is a first-class row, not a marker in prose.** Bytes on disk, metadata in sqlite:

```sql
-- migration: append to MIGRATIONS in db.ts
create table attachments (
  id         text primary key,
  message_id integer references task_messages(id) on delete cascade,  -- null until bound
  task_id    text    references tasks(id) on delete cascade,
  kind       text not null,               -- 'image' today; the column is why audio is not a migration
  media_type text not null,               -- image/png | image/jpeg | image/webp | image/gif
  file       text not null,               -- absolute path under <dataDir>/attachments/<taskId>/
  bytes      integer not null,
  width      integer, height integer,
  created_at integer not null
);
create index attachments_message on attachments(message_id);
```

⛔ Bytes on disk, not in the row. A pasted screenshot is ~1–3 MB and this database is opened by the
daemon on every tick; blobs there would bloat the WAL for data that is only ever read whole, by path,
and mostly by a CLI rather than by us.

## 5. The path through the code

Nine edits, in dependency order.

1. **`src/shared/protocol.ts` / `src/shared/tasks.ts`** — `imageInput` replaces `multimodalInput`;
   `Attachment`; `TaskMessage.attachments: Attachment[]`; `TaskCreateParams.attachmentIds?`,
   `task.message` params gain `attachmentIds?`; new RPC `attachment.create` and `attachment.read`.
2. **`src/daemon/db.ts`** — the migration above, appended (never edited in place).
3. **`src/daemon/attachments.ts`** *(new)* — the only place that writes bytes.
   `createAttachment(bytes, mediaType)` → validates the magic number against the declared media type
   (⛔ never trust the renderer's `type`), writes `<dataDir>/attachments/pending/<id>.<ext>`, returns
   the row. `bindAttachments(ids, taskId, messageId)` moves the file under
   `<dataDir>/attachments/<taskId>/` and fills the columns. `attachmentsFor(messageIds)`.
   `prunePending(olderThanMs)` — runs at startup and daily; an image pasted into a form that was then
   abandoned is otherwise a file nobody ever deletes.
4. **`src/daemon/tasks.ts`** — `addMessage` takes optional `attachmentIds` and binds them in the same
   transaction that writes the message; `messagesFor` joins the attachments on.
5. **`src/daemon/scheduler.ts` — `promptFor` returns `{ text, attachments }`, not a string.** This is
   the load-bearing edit. It already computes exactly which messages are outstanding and marks them
   delivered; the attachments of those same messages are what travels with this prompt, and any other
   rule would either replay an image on every run or drop it on a re-run after preemption. The path
   text is appended by `promptFor` in the same pass:

   > `Attached: C:\…\attachments\<taskId>\a1.png (a screenshot, 1568×982). Open it if you need to see it.`

   ⚠️ **Hoist the `promptFor` call above `spawnSession`.** Today it sits below (scheduler.ts:1346,
   spawn at ~1329), and a `spawn-flag` adapter needs the file list to build its argv. Everything
   `promptFor` depends on — `revive`, `branchNotice`, `movedSince` — is already resolved before the
   spawn, so this is a move, not a restructure.
6. **`src/daemon/sessions.ts`** — `sendPrompt(id, text, attachments = [])`. It reads
   `imageInput` and, on `'none'`, **sends text only and logs once at warn**. ⛔ This is the guard the
   agy measurement demands: the alternative is a turn that fails with `num_turns: 0` and gets blamed
   on the agent. On `'spawn-flag'` it also sends text only — the bytes went into the argv already and
   a second copy would be paid for twice.
7. **`src/daemon/adapters/types.ts` + the three adapters** —
   `encodeStreamPrompt(text, attachments)`. claude-code appends
   `{type:'image',source:{type:'base64',…}}` blocks **before** the text block, which is the order the
   measurement used and the order the vendor documents. antigravity's is unchanged and declares
   `imageInput: 'none'`. `SpawnRequest` gains `attachments`; codex's `plan()` pushes
   `-i <file>` per image, plus `--add-dir <attachmentDir>` so its sandbox can read them; claude's and
   agy's `plan()` push `--add-dir <attachmentDir>` when the run carries any, so the file path in the
   prompt is one the agent is actually allowed to open.
8. **`src/daemon/api.ts`** — `attachment.create` (one image per call, see §6), `attachment.read` for
   the renderer's thumbnails, `task.create`/`task.message` forward `attachmentIds`,
   `deliverToLiveSession` carries them, and `previewPrompt` renders the path lines so the preview
   still equals what the agent gets.
9. **The renderer** — `Tasks.tsx` (New Task) and `TaskThread.tsx` (note box) get one shared
   `usePastedImages()` hook: `onPaste` reads `clipboardData.items` for `kind === 'file'` and a
   `image/*` type, downscales on a canvas to **1568px on the longest edge** (the vendor's own
   recommendation, and the difference between ~1.1k and ~4k tokens for a full-screen grab), uploads
   each through `attachment.create`, and shows a removable thumbnail chip. Drag-and-drop uses the
   same hook. `TaskThread` renders an `attachment.read` data URL under any message that has one.

## 6. Two limits, and why they are these numbers

- **`MAX_BODY_BYTES` in `server.ts` is 4 MB and stays 4 MB.** `attachment.create` takes **one image
  per call**, so eight pasted screenshots are eight requests of ~2 MB rather than one of 16 MB.
  Raising a limit to fit a payload that can be split is how a limit stops meaning anything.
- **Eight images per message, 10 MB each before downscale.** Refused at the door with a real message,
  not silently truncated.

## 7. Tests

- `attachments.test.ts` *(new)* — magic-number validation rejects a `.exe` renamed `.png`; bind moves
  the file and survives a task delete; `prunePending` deletes an orphan and never a bound one.
- `adapters.test.ts` — **the regression that matters**: `encodeStreamPrompt` on antigravity with an
  attachment present must produce a payload containing **no image block**, and `sendPrompt` must not
  offer one to an `imageInput: 'none'` adapter. Plus: claude's envelope carries the block in the
  documented order; codex's `plan()` argv contains `-i <file>` and `--add-dir`.
- `tasks.test.ts` — an attachment travels on the run that delivers its message and **not** on the
  next one; it *does* travel again when a preemption re-sends the first prompt.
- `test/ui.test.mjs` — paste a synthetic PNG into New Task, assert the chip, assert the created
  task's first message carries one attachment; assert the thread renders a thumbnail.

## 8. What this will not have proven

- **R16 — has an inline image ever reached a real dispatched run?** §2 measured the CLI directly, not
  the daemon driving it. One Claude task filed with a screenshot, answered from the image, settles
  it. Cheap.
- **R16b — does an MCP tool result carry an image back to the model?** Unmeasured, and the reason
  question answers are out of scope (§3.1). A one-line experiment against `ask_human` answers it and
  would open the third surface with no further design.
- **Codex's vision is weak on small synthetic images** and it prefers to shell out. Not a defect
  here, but it means a codex task given a screenshot may well ignore the attachment and read the
  file — which is precisely what the path fallback is for.
- **Nothing off Windows**, as ever: the path text embedded in the prompt is an absolute path, and the
  `--add-dir` grants are argv-proven only.
