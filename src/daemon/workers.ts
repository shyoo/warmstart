import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Worker, WorkerRole } from '@shared/protocol.js'
import { db, row, rows } from './db.js'
import { ensureDir, paths, slugify } from './paths.js'
import { adapter, hasAdapter } from './adapters/index.js'
import { log } from './log.js'
import { emit } from './events.js'

interface WorkerRow {
  id: string
  adapter_id: string
  label: string
  isolation_root: string
  enabled: number
  human_occupied: number
  role: string
  max_concurrent: number
  identity_json: string | null
  created_at: number
  retired_at: number | null
}

function toWorker(r: WorkerRow): Worker {
  return {
    id: r.id,
    adapterId: r.adapter_id,
    label: r.label,
    isolationRoot: r.isolation_root,
    enabled: r.enabled === 1,
    humanOccupied: r.human_occupied === 1,
    role: (r.role as WorkerRole) ?? 'both',
    maxConcurrent: r.max_concurrent,
    identity: r.identity_json ? JSON.parse(r.identity_json) : null,
    createdAt: r.created_at,
    retiredAt: r.retired_at
  }
}

export function listWorkers(includeRetired = false): Worker[] {
  const sql = includeRetired
    ? 'select * from workers order by created_at'
    : 'select * from workers where retired_at is null order by created_at'
  return rows<WorkerRow>(db().prepare(sql).all()).map(toWorker)
}

export function getWorker(id: string): Worker | null {
  const r = row<WorkerRow>(db().prepare('select * from workers where id = ?').get(id))
  return r ? toWorker(r) : null
}

export function requireWorker(id: string): Worker {
  const w = getWorker(id)
  if (!w) throw new Error(`no worker '${id}'`)
  return w
}

/**
 * Commission a worker.
 *
 * The isolation root is a directory the *vendor CLI* owns. agentyard creates it and points the CLI
 * at it; it never reads, copies or proxies what lands inside. An existing root can be adopted
 * instead - including a plain `~/.claude` - which is the path for someone who already has one
 * account set up and does not want to log in again.
 */
export function createWorker(input: {
  adapterId: string
  label: string
  isolationRoot?: string | undefined
  humanOccupied?: boolean | undefined
  maxConcurrent?: number | undefined
  enabled?: boolean | undefined
}): Worker {
  if (!hasAdapter(input.adapterId)) throw new Error(`unknown adapter '${input.adapterId}'`)
  const label = input.label.trim()
  if (!label) throw new Error('a worker needs a label')

  // ⛔ Refused here rather than discovered later. Some CLIs keep their credential in the OS keyring
  // with no way to point them at a different one - Antigravity is the first - so a second worker
  // would not be a second account. It would be two rows sharing one account's quota, each believing
  // it had a window of its own, and the scheduler would happily overspend it. A refusal now beats
  // that, and the message says why rather than just saying no.
  const caps = adapter(input.adapterId).info.capabilities
  const limit = caps.maxAccounts
  if (limit !== null) {
    const existing = listWorkers(true).filter((w) => w.adapterId === input.adapterId && !w.retiredAt)
    if (existing.length >= limit) {
      const info = adapter(input.adapterId).info
      throw new Error(
        `${info.label} supports only ${limit} account on this machine: it keeps credentials in the ` +
          'OS keyring and offers no way to point it at another. ' +
          `'${existing[0]?.label}' already holds it. Retire that worker to commission a different one.`
      )
    }
  }

  const id = randomUUID()
  const root = input.isolationRoot?.trim() || defaultIsolationRoot(label)
  ensureDir(root)

  const now = Date.now()
  db()
    .prepare(
      `insert into workers (id, adapter_id, label, isolation_root, enabled, human_occupied,
                            max_concurrent, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.adapterId,
      label,
      root,
      input.enabled === false ? 0 : 1,
      input.humanOccupied ? 1 : 0,
      // Default 1: concurrent requests against one cached prefix each pay a write, so a second
      // session on the same worker is a cost decision, not a free speedup. cost-model.md §1.
      input.maxConcurrent ?? 1,
      now
    )
  log.info(`commissioned worker ${label} (${input.adapterId}) at ${root}`)
  return announce(requireWorker(id))
}

/** `<data>/workers/<slug>`, with a numeric suffix if that name is taken. Never machine-specific. */
export function defaultIsolationRoot(label: string): string {
  ensureDir(paths.workers)
  const base = slugify(label)
  let candidate = join(paths.workers, base)
  let n = 2
  while (existsSync(candidate)) candidate = join(paths.workers, `${base}-${n++}`)
  return candidate
}

export function updateWorker(
  id: string,
  patch: Partial<Pick<Worker, 'label' | 'enabled' | 'humanOccupied' | 'maxConcurrent' | 'role'>>
): Worker {
  const current = requireWorker(id)
  db()
    .prepare(
      `update workers set label = ?, enabled = ?, human_occupied = ?, max_concurrent = ?, role = ?
       where id = ?`
    )
    .run(
      patch.label?.trim() || current.label,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      (patch.humanOccupied ?? current.humanOccupied) ? 1 : 0,
      patch.maxConcurrent ?? current.maxConcurrent,
      patch.role ?? current.role,
      id
    )
  return announce(requireWorker(id))
}

/** Every worker mutation leaves through here, so no UI can miss one. */
function announce(worker: Worker): Worker {
  emit({ type: 'worker.changed', worker })
  return worker
}

/**
 * Retiring closes the worker to new work but **leaves the isolation root on disk**. A credential
 * store is not something a task manager deletes on a stray click; removing it is a separate,
 * explicit act by the person who owns the account.
 */
export function retireWorker(id: string): Worker {
  db().prepare('update workers set retired_at = ?, enabled = 0 where id = ?').run(Date.now(), id)
  const w = requireWorker(id)
  log.info(`retired worker ${w.label}; isolation root left at ${w.isolationRoot}`)
  return announce(w)
}

export async function refreshIdentity(id: string): Promise<Worker> {
  const w = requireWorker(id)
  const probe = await adapter(w.adapterId).probeIdentity(w.isolationRoot)
  const identity = {
    // ⛔ Kept, not dropped. The adapter answered this question; throwing it away and having the
    // scheduler grep `raw` for `"loggedIn": false` is how a worker with no CLI installed used to
    // look dispatchable.
    loggedIn: probe.loggedIn,
    account: probe.account,
    organization: probe.organization,
    cliVersion: probe.cliVersion,
    raw: probe.raw,
    checkedAt: Date.now()
  }
  db().prepare('update workers set identity_json = ? where id = ?').run(JSON.stringify(identity), id)
  return announce(requireWorker(id))
}
