import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

/**
 * Web Push: VAPID (RFC 8292) and the `aes128gcm` payload encryption (RFC 8291).
 *
 * ⛔ **The daemon needs no inbound reachability for this.** A phone's subscription names a push
 * endpoint at Google, Apple or Mozilla; the daemon POSTs to it, and the phone's own OS delivers it.
 * That is the whole reason notifications work when the phone is asleep on a different network,
 * where the `/remote/events` socket does not.
 *
 * ⚠️ Written here rather than pulled in for the same reason as `qr.ts`: the useful half of the
 * `web-push` package is 120 lines of `node:crypto` and its own test can prove them, by decrypting
 * with the subscriber's private key exactly as a browser does.
 *
 * ⛔ Everything is public-key material except the VAPID private key, which is generated on this
 * machine, stored in the daemon database, and never sent anywhere — a push endpoint verifies the
 * *signature*, never the key.
 */

/** What a browser hands back from `pushManager.subscribe()`. */
export interface PushSubscription {
  endpoint: string
  /** The subscriber's public key, base64url, as an uncompressed P-256 point. */
  p256dh: string
  /** The subscriber's 16-byte authentication secret, base64url. */
  auth: string
}

export interface VapidKeys {
  /** base64url of the uncompressed P-256 point — this is `applicationServerKey` in the browser. */
  publicKey: string
  /** PKCS#8 PEM. ⛔ Never leaves this machine. */
  privateKey: string
}

const b64url = (buf: Buffer): string => buf.toString('base64url')
const fromB64url = (text: string): Buffer => Buffer.from(text, 'base64url')

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
  // 0x04 marks an uncompressed point, which is the only form `applicationServerKey` accepts.
  const point = Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)])
  return {
    publicKey: b64url(point),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  }
}

/**
 * The VAPID `Authorization` header: a JWT saying who is pushing and to which push service.
 *
 * ⚠️ `sub` is required to be a `mailto:` or `https:` URI and is only ever read by a push service
 * operator wanting to complain about traffic. There is no account behind this and none is implied,
 * so it names the software rather than the person running it.
 */
export function vapidHeader(keys: VapidKeys, endpoint: string, now = Date.now()): string {
  const audience = new URL(endpoint).origin
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        // 12 hours: comfortably inside the 24-hour ceiling RFC 8292 puts on this.
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: 'mailto:noreply@multi-agent-controller.invalid'
      })
    )
  )
  const signed = `${header}.${claims}`
  // ⛔ `ieee-p1363`, not DER: a JWS ES256 signature is the raw r‖s pair, and the DER default is
  // accepted by nothing.
  const signature = sign('sha256', Buffer.from(signed), {
    key: createPrivateKey(keys.privateKey),
    dsaEncoding: 'ieee-p1363'
  })
  return `vapid t=${signed}.${b64url(signature)},k=${keys.publicKey}`
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()

/** HKDF, both halves, for the one output length this needs. */
const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer =>
  hmac(hmac(salt, ikm), Buffer.concat([info, Buffer.from([1])])).subarray(0, length)

/**
 * Encrypt one payload for one subscriber, producing an `aes128gcm` body ready to POST.
 *
 * The record layout is RFC 8188 §2.1: salt, record size, key id length, the sender's public key,
 * then the single encrypted record. `ephemeral` is injectable so the test can pin it.
 */
export function encryptPayload(
  subscription: Pick<PushSubscription, 'p256dh' | 'auth'>,
  payload: string,
  ephemeral?: ReturnType<typeof createECDH>,
  salt = randomBytes(16)
): Buffer {
  const uaPublic = fromB64url(subscription.p256dh)
  const authSecret = fromB64url(subscription.auth)
  const sender = ephemeral ?? createECDH('prime256v1')
  if (!ephemeral) sender.generateKeys()
  const asPublic = sender.getPublicKey()
  const shared = sender.computeSecret(uaPublic)

  // RFC 8291 §3.3: the authentication secret keys a first HKDF whose info binds both public keys,
  // so a ciphertext is bound to this exact pair and cannot be replayed at another subscriber.
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 is the padding delimiter for the *last* record; there is only ever one record here.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body])
}

/** What the caller must do about the answer. `gone` means prune the subscription and never retry. */
export type PushOutcome = 'delivered' | 'gone' | 'failed'

export function outcomeFor(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'delivered'
  // ⛔ 404 and 410 are the push service saying this subscription will never work again. Anything
  // else — 429, 5xx, a timeout — is this moment, not this subscription, and must not delete it.
  if (status === 404 || status === 410) return 'gone'
  return 'failed'
}

/**
 * POST one notification. ⚠️ Never throws: a push service being unreachable is a normal condition
 * on a laptop that just woke up, and it must not take a scheduler tick with it.
 */
export async function sendPush(keys: VapidKeys, subscription: PushSubscription, payload: string, timeoutMs = 10_000): Promise<PushOutcome> {
  const body = encryptPayload(subscription, payload)
  try {
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidHeader(keys, subscription.endpoint),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
        urgency: 'high'
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return outcomeFor(res.status)
  } catch {
    return 'failed'
  }
}

/** The subscriber half, for tests: the keypair and auth secret a browser would have generated. */
export function subscriberKeys(): { p256dh: string; auth: string; ecdh: ReturnType<typeof createECDH> } {
  const ecdh = createECDH('prime256v1')
  return { p256dh: b64url(ecdh.generateKeys()), auth: b64url(randomBytes(16)), ecdh }
}

/** The public key of a VAPID pair, as a `KeyObject`, so a test can verify the JWT signature. */
export function vapidPublicKeyObject(keys: VapidKeys): ReturnType<typeof createPublicKey> {
  return createPublicKey(createPrivateKey(keys.privateKey))
}
