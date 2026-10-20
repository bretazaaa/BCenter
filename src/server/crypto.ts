import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import type { SecretCipher } from '../main/data/secrets'

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>

/**
 * Chiffrement des secrets côté serveur (remplace Windows DPAPI) : AES-256-GCM avec une clé de 32 octets,
 * fournie par BCENTER_SECRET_KEY (base64) ou générée au premier démarrage dans le volume de données (droits 600).
 */
export function serverCipher(keyFile: string, envKey?: string): SecretCipher {
  let key: Buffer
  if (envKey) {
    key = Buffer.from(envKey, 'base64')
    if (key.length !== 32) throw new Error('BCENTER_SECRET_KEY doit contenir 32 octets encodés en base64 (openssl rand -base64 32).')
  } else if (existsSync(keyFile)) {
    key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64')
  } else {
    key = randomBytes(32)
    writeFileSync(keyFile, key.toString('base64'), { mode: 0o600 })
  }
  try {
    chmodSync(keyFile, 0o600)
  } catch {
    // Clé fournie par variable d'environnement ou système de fichiers sans droits POSIX.
  }
  if (key.length !== 32) throw new Error(`Clé de chiffrement invalide : ${keyFile}`)

  return {
    isAvailable: () => true,
    encrypt(plain) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      // Format : version (1) | iv (12) | tag (16) | données.
      return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data])
    },
    decrypt(blob) {
      if (blob[0] !== 1) throw new Error('Format de secret inconnu.')
      const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(1, 13))
      decipher.setAuthTag(blob.subarray(13, 29))
      return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString('utf8')
    },
  }
}

// ------------------------------------------------------------------ Mots de passe (scrypt)

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const hash = await scryptAsync(password, salt, 32, SCRYPT)
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const expected = Buffer.from(hash, 'base64')
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { ...SCRYPT, N: Number(n) })
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// ------------------------------------------------------------------ TOTP (RFC 6238)

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(data: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of data) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** Code à 6 chiffres pour un pas de 30 s donné. */
export function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const hmac = createHmac('sha1', secret).update(counter).digest()
  const offset = hmac[hmac.length - 1] & 15
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(code).padStart(6, '0')
}

/**
 * Vérifie un code (tolérance d'un pas de 30 s avant ou après). Renvoie le pas utilisé, à mémoriser
 * pour refuser la réutilisation d'un même code, ou null.
 */
export function verifyTotp(secret: Buffer, code: string, lastStep: number, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(now / 30_000)
  for (const step of [current, current - 1, current + 1]) {
    if (step <= lastStep) continue
    const expected = Buffer.from(totp(secret, step))
    if (timingSafeEqual(expected, Buffer.from(code))) return step
  }
  return null
}
