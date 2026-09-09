import { describe, expect, it } from 'vitest'
import { createDecipheriv, createHmac, createPublicKey, verify } from 'node:crypto'
import { encryptPayload, generateVapidKeys, outcomeFor, subscriberKeys, vapidHeader } from './webpush.js'

/**
 * ⛔ Nothing in this repo can drive a real push service, so this file plays the *subscriber*: it
 * decrypts with the private key the browser would have held, deriving the keys from RFC 8291
 * independently rather than calling back into the encoder's helpers. A payload that decrypts to
 * the right bytes under an independently-derived key is one a phone can read.
 */

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()
const hkdf = (salt: Buffer, ikm: Buffer, info: string, length: number): Buffer =>
  hmac(hmac(salt, ikm), Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).subarray(0, length)

/** The browser's half of RFC 8291 §3.4, and RFC 8188 §2.1 for the record header. */
function decrypt(body: Buffer, subscriber: ReturnType<typeof subscriberKeys>): string {
  const salt = body.subarray(0, 16)
  const idLength = body[20]!
  const asPublic = body.subarray(21, 21 + idLength)
  const ciphertext = body.subarray(21 + idLength)
  expect(body.readUInt32BE(16)).toBe(4096)
  expect(idLength).toBe(65)

  const shared = subscriber.ecdh.computeSecret(asPublic)
  const uaPublic = Buffer.from(subscriber.p256dh, 'base64url')
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hmac(hmac(Buffer.from(subscriber.auth, 'base64url'), shared), Buffer.concat([keyInfo, Buffer.from([1])])).subarray(0, 32)
  const cek = hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16)
  const nonce = hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12)

  const tag = ciphertext.subarray(ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // The last byte is the padding delimiter for the final record.
  expect(plain[plain.length - 1]).toBe(2)
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

describe('web push', () => {
  it('encrypts a payload the subscriber can decrypt, and only that subscriber', () => {
    const subscriber = subscriberKeys()
    const payload = JSON.stringify({ title: 'A question needs you', body: 't41: rename the thing', taskId: 'abc' })
    expect(decrypt(encryptPayload(subscriber, payload), subscriber)).toBe(payload)

    // ⛔ A ciphertext is bound to one subscriber's keys. Another phone's must not open it.
    const other = subscriberKeys()
    expect(() => decrypt(encryptPayload(subscriber, payload), other)).toThrow()
  })

  it('uses a fresh ephemeral key and salt every time', () => {
    const subscriber = subscriberKeys()
    const first = encryptPayload(subscriber, 'x')
    const second = encryptPayload(subscriber, 'x')
    expect(first.subarray(0, 16).equals(second.subarray(0, 16))).toBe(false)
    expect(first.subarray(21, 86).equals(second.subarray(21, 86))).toBe(false)
  })

  it('signs a VAPID token the push service can verify against the advertised key', () => {
    const keys = generateVapidKeys()
    const header = vapidHeader(keys, 'https://fcm.googleapis.com/fcm/send/abc123', 1_700_000_000_000)
    const [token, advertised] = header.replace(/^vapid /, '').split(',')
    expect(advertised).toBe(`k=${keys.publicKey}`)

    const jwt = token!.replace(/^t=/, '')
    const [encodedHeader, claims, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(encodedHeader!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    const payload = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as { aud: string; exp: number; sub: string }
    // ⛔ The audience is the push service's *origin*, never the full endpoint.
    expect(payload.aud).toBe('https://fcm.googleapis.com')
    expect(payload.exp).toBe(1_700_000_000 + 12 * 60 * 60)
    expect(payload.sub.startsWith('mailto:')).toBe(true)

    // The raw r‖s signature, verified against the same P-256 point the header advertises.
    const point = Buffer.from(keys.publicKey, 'base64url')
    const jwk = {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url')
    }
    const ok = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${claims}`),
      { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature!, 'base64url')
    )
    expect(ok).toBe(true)
  })

  it('deletes a subscription only when the push service says it is gone for good', () => {
    expect(outcomeFor(201)).toBe('delivered')
    expect(outcomeFor(200)).toBe('delivered')
    expect(outcomeFor(410)).toBe('gone')
    expect(outcomeFor(404)).toBe('gone')
    // ⛔ Rate limiting and outages are this moment, not this subscription.
    expect(outcomeFor(429)).toBe('failed')
    expect(outcomeFor(503)).toBe('failed')
  })
})
