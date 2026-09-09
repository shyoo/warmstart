import type { DaemonEvent } from '@shared/protocol.js'
import { db, row, rows } from '../db.js'
import { log } from '../log.js'
import { AlertGate, alertFor, type Alert } from './alerts.js'
import { generateVapidKeys, sendPush, type PushSubscription, type VapidKeys } from './webpush.js'

/**
 * Push subscriptions, and the one place an event turns into a notification.
 *
 * ⛔ A subscription belongs to a *device*, and revoking that device takes its subscriptions with it
 * — otherwise a lost phone keeps being told what the fleet is doing after the operator has already
 * revoked it, which is the one thing the Revoke button is for.
 */

interface SubscriptionRow {
  endpoint: string
  device_id: string
  p256dh: string
  auth: string
}

/**
 * The signing pair, minted once and kept.
 *
 * ⛔ Not part of `RemoteConfig`: writing that fires the change listener, which restarts the
 * listener, and generating a key on first use would bounce every connected phone. It is also not
 * a *preference* — nothing about it is the operator's to choose.
 */
export function vapidKeys(): VapidKeys {
  const read = (key: string): string | null =>
    row<{ value: string }>(db().prepare('select value from remote_config where key = ?').get(key))?.value ?? null
  const publicKey = read('vapidPublicKey')
  const privateKey = read('vapidPrivateKey')
  if (publicKey && privateKey) return { publicKey: JSON.parse(publicKey) as string, privateKey: JSON.parse(privateKey) as string }
  const minted = generateVapidKeys()
  const write = db().prepare(
    'insert into remote_config (key,value,updated_at) values (?,?,?) on conflict(key) do update set value=excluded.value,updated_at=excluded.updated_at'
  )
  write.run('vapidPublicKey', JSON.stringify(minted.publicKey), Date.now())
  write.run('vapidPrivateKey', JSON.stringify(minted.privateKey), Date.now())
  return minted
}

export function subscribePush(deviceId: string, subscription: PushSubscription): void {
  db()
    .prepare(
      `insert into remote_push_subscriptions (endpoint,device_id,p256dh,auth,created_at) values (?,?,?,?,?)
       on conflict(endpoint) do update set device_id=excluded.device_id, p256dh=excluded.p256dh, auth=excluded.auth`
    )
    .run(subscription.endpoint, deviceId, subscription.p256dh, subscription.auth, Date.now())
}

export function unsubscribePush(endpoint: string): void {
  db().prepare('delete from remote_push_subscriptions where endpoint = ?').run(endpoint)
}

/** ⛔ Called by revocation. A revoked device must stop being told things, not merely stop asking. */
export function dropDeviceSubscriptions(deviceId: string): void {
  db().prepare('delete from remote_push_subscriptions where device_id = ?').run(deviceId)
}

export function listPushSubscriptions(): Array<PushSubscription & { deviceId: string }> {
  return rows<SubscriptionRow>(db().prepare('select * from remote_push_subscriptions').all()).map((r) => ({
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
    deviceId: r.device_id
  }))
}

/**
 * Turn events into notifications for as long as remote access is on.
 *
 * ⚠️ `visible` is the caller's project filter, the same one the event socket uses — a project the
 * operator has not exposed must not reach a phone by a second route.
 */
export function createPushDispatcher(options: {
  visible: (event: DaemonEvent) => boolean
  enabled: () => boolean
}): { deliver: (event: DaemonEvent) => void } {
  const gate = new AlertGate()
  return {
    deliver(event) {
      if (!options.enabled() || !options.visible(event)) return
      const alert = alertFor(event)
      if (!alert || !gate.admit(alert.key)) return
      void fanOut(alert)
    }
  }
}

async function fanOut(alert: Alert): Promise<void> {
  const subscriptions = listPushSubscriptions()
  if (subscriptions.length === 0) return
  // ⛔ The payload carries an id and a sentence, never a prompt, a path or a credential: it is
  // decrypted by the phone's browser and shown on a lock screen anyone holding the phone can read.
  const payload = JSON.stringify({ title: alert.title, body: alert.body, taskId: alert.taskId })
  const keys = vapidKeys()
  await Promise.all(
    subscriptions.map(async (subscription) => {
      const outcome = await sendPush(keys, subscription, payload)
      if (outcome === 'gone') unsubscribePush(subscription.endpoint)
      else if (outcome === 'failed') log.warn(`remote push not delivered to ${new URL(subscription.endpoint).host}`)
    })
  )
}
