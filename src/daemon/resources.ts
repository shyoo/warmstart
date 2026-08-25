import { randomUUID } from 'node:crypto'
import type { Resource, ResourceAvailability, ResourceClaim, ResourceKind } from '@shared/tasks.js'
import { db, row, rows } from './db.js'
import { emit } from './events.js'
import { log } from './log.js'

/**
 * The resource broker.
 *
 * A Resource is *anything contended for*: a workspace, a browser profile, a credit-metered API, a
 * port block, a device, a flaky test that must not run twice at once. Landing is one too.
 *
 * The point of modelling these at all: **if the scheduler owns the claim, the lock is unnecessary.**
 * Agents never have to coordinate, because nothing dispatches two claimants at once. A hand-rolled
 * lock inside an agent prompt is a symptom of the scheduler not knowing about a resource.
 *
 * ⛔ Every claim must be released, including on the failure path. A cancel that leaks an exclusive
 * claim deadlocks the fleet - see `releaseAllFor`.
 */

interface ResourceRow {
  id: string
  project_id: string | null
  kind: string
  label: string
  capacity: number
  members_json: string
  meta_json: string
}

interface ClaimRow {
  id: string
  resource_id: string
  member: string | null
  holder: string
  amount: number
  acquired_at: number
  released_at: number | null
}

function toResource(r: ResourceRow): Resource {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind as ResourceKind,
    label: r.label,
    capacity: r.capacity,
    members: JSON.parse(r.members_json) as string[],
    meta: JSON.parse(r.meta_json) as Record<string, unknown>
  }
}

function toClaim(r: ClaimRow): ResourceClaim {
  return {
    id: r.id,
    resourceId: r.resource_id,
    member: r.member,
    holder: r.holder,
    amount: r.amount,
    acquiredAt: r.acquired_at,
    releasedAt: r.released_at
  }
}

export function listResources(projectId?: string): Resource[] {
  const sql = projectId
    ? 'select * from resources where project_id = ? or project_id is null order by label'
    : 'select * from resources order by label'
  const list = projectId ? db().prepare(sql).all(projectId) : db().prepare(sql).all()
  return rows<ResourceRow>(list).map(toResource)
}

export function getResource(id: string): Resource | null {
  const r = row<ResourceRow>(db().prepare('select * from resources where id = ?').get(id))
  return r ? toResource(r) : null
}

/** Idempotent: declaring a resource that already exists updates its shape rather than duplicating. */
export function upsertResource(input: {
  id: string
  projectId?: string | null
  kind: ResourceKind
  label: string
  capacity?: number
  members?: string[]
  meta?: Record<string, unknown>
}): Resource {
  const members = input.members ?? []
  const capacity = input.kind === 'exclusive' ? 1 : (input.capacity ?? Math.max(1, members.length))
  db()
    .prepare(
      `insert into resources (id, project_id, kind, label, capacity, members_json, meta_json)
       values (?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         project_id = excluded.project_id, kind = excluded.kind, label = excluded.label,
         capacity = excluded.capacity, members_json = excluded.members_json,
         meta_json = excluded.meta_json`
    )
    .run(
      input.id,
      input.projectId ?? null,
      input.kind,
      input.label,
      capacity,
      JSON.stringify(members),
      JSON.stringify(input.meta ?? {})
    )
  const resource = getResource(input.id)
  if (!resource) throw new Error(`resource '${input.id}' vanished after upsert`)
  return resource
}

export function openClaims(resourceId: string): ResourceClaim[] {
  return rows<ClaimRow>(
    db()
      .prepare('select * from resource_claims where resource_id = ? and released_at is null')
      .all(resourceId)
  ).map(toClaim)
}

export function availability(resourceId: string): ResourceAvailability | null {
  const resource = getResource(resourceId)
  if (!resource) return null
  const claims = openClaims(resourceId)
  const inUse = claims.reduce((sum, c) => sum + c.amount, 0)
  return { resource, inUse, free: Math.max(0, resource.capacity - inUse), claims }
}

export function allAvailability(): ResourceAvailability[] {
  return listResources()
    .map((r) => availability(r.id))
    .filter((a): a is ResourceAvailability => a !== null)
}

/**
 * Take a claim, or return null. **Never blocks and never queues** - the scheduler asks, and if the
 * answer is no it dispatches something else. A broker that blocks is a lock with extra steps.
 */
export function claim(
  resourceId: string,
  holder: string,
  amount = 1
): ResourceClaim | null {
  const state = availability(resourceId)
  if (!state) throw new Error(`no resource '${resourceId}'`)
  if (state.free < amount) return null

  // Named members give a pool identity: which workspace, which profile, which port block.
  let member: string | null = null
  if (state.resource.members.length > 0) {
    const taken = new Set(state.claims.map((c) => c.member))
    member = state.resource.members.find((m) => !taken.has(m)) ?? null
    if (!member) return null
  }

  const record: ClaimRow = {
    id: randomUUID(),
    resource_id: resourceId,
    member,
    holder,
    amount,
    acquired_at: Date.now(),
    released_at: null
  }
  db()
    .prepare(
      `insert into resource_claims (id, resource_id, member, holder, amount, acquired_at)
       values (?, ?, ?, ?, ?, ?)`
    )
    .run(record.id, resourceId, member, holder, amount, record.acquired_at)

  announce(resourceId)
  return toClaim(record)
}

export function release(claimId: string): void {
  const r = row<ClaimRow>(db().prepare('select * from resource_claims where id = ?').get(claimId))
  if (!r || r.released_at) return
  db().prepare('update resource_claims set released_at = ? where id = ?').run(Date.now(), claimId)
  announce(r.resource_id)
}

/**
 * Release everything a holder still has.
 *
 * ⛔ Called on **every** exit path a run can take - completion, failure, cancel, kill, daemon
 * shutdown - and deliberately not conditional on any of them succeeding. One leaked exclusive claim
 * stalls a project forever, and the symptom (nothing dispatches, nothing errors) is the worst kind.
 */
export function releaseAllFor(holder: string): number {
  const held = rows<ClaimRow>(
    db()
      .prepare('select * from resource_claims where holder = ? and released_at is null')
      .all(holder)
  )
  for (const c of held) release(c.id)
  if (held.length) log.debug(`released ${held.length} claim(s) held by ${holder}`)
  return held.length
}

/**
 * At startup, claims recorded by a daemon that has since died are lies - whatever held them is gone.
 * Clearing them is what stops a crash from permanently costing a workspace.
 */
export function reconcileClaims(): number {
  const stale = db()
    .prepare('select count(*) as n from resource_claims where released_at is null')
    .get() as { n: number }
  if (stale.n > 0) {
    db().prepare('update resource_claims set released_at = ? where released_at is null').run(Date.now())
    log.warn(`released ${stale.n} resource claim(s) left behind by a previous run`)
  }
  return stale.n
}

function announce(resourceId: string): void {
  const state = availability(resourceId)
  if (state) emit({ type: 'resource.changed', availability: state })
}

/** Landing is serialised per project: three workspaces finishing at once would race on the trunk. */
export function landResourceId(projectId: string): string {
  return `land:${projectId}`
}

export function workspacePoolId(projectId: string): string {
  return `workspace:${projectId}`
}
