import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type Database } from '../main/data/database'
import { SecretStore } from '../main/data/secrets'
import { AuthService } from './auth'
import { base32Decode, base32Encode, hashPassword, serverCipher, totp, verifyPassword, verifyTotp } from './crypto'

describe('chiffrement et mots de passe', () => {
  it('TOTP : vecteurs de la RFC 6238 (SHA-1, 6 chiffres)', () => {
    const secret = Buffer.from('12345678901234567890')
    expect(totp(secret, Math.floor(59 / 30))).toBe('287082')
    expect(totp(secret, Math.floor(1111111109 / 30))).toBe('081804')
    expect(totp(secret, Math.floor(2000000000 / 30))).toBe('279037')
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true)
  })

  it('TOTP : tolérance d’un pas, refus d’un code réutilisé', () => {
    const secret = Buffer.from('12345678901234567890')
    const now = 1111111109_000
    const step = Math.floor(now / 30_000)
    expect(verifyTotp(secret, totp(secret, step), 0, now)).toBe(step)
    expect(verifyTotp(secret, totp(secret, step - 1), 0, now)).toBe(step - 1)
    expect(verifyTotp(secret, totp(secret, step - 2), 0, now)).toBeNull()
    expect(verifyTotp(secret, totp(secret, step), step, now)).toBeNull()
    expect(verifyTotp(secret, 'abcdef', 0, now)).toBeNull()
  })

  it('scrypt et AES-256-GCM', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
    expect(await verifyPassword('wrong password!!', hash)).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'bcenter-key-'))
    try {
      const cipher = serverCipher(join(dir, 'secret.key'))
      const blob = cipher.encrypt('jeton-api')
      expect(blob.includes(Buffer.from('jeton-api'))).toBe(false)
      expect(cipher.decrypt(blob)).toBe('jeton-api')
      blob[blob.length - 1] ^= 1
      expect(() => cipher.decrypt(blob)).toThrow()
      // La même clé est relue au redémarrage.
      expect(serverCipher(join(dir, 'secret.key')).decrypt(cipher.encrypt('x'))).toBe('x')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('authentification web', () => {
  let dir: string
  let db: Database
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const create = () => {
    dir = mkdtempSync(join(tmpdir(), 'bcenter-auth-'))
    db = openDatabase(join(dir, 'db.sqlite'))
    const secrets = new SecretStore(db, serverCipher(join(dir, 'secret.key')))
    return { auth: new AuthService(db, secrets), secrets }
  }

  it('installation protégée par code, connexion avec 2FA, session et blocage', async () => {
    const { auth } = create()
    expect(auth.setupCode).toMatch(/^\d{4}-\d{4}-\d{4}$/)
    await expect(auth.startSetup('1.1.1.1', 'mauvais')).rejects.toThrow(/Code d’installation/)
    const { secret } = await auth.startSetup('1.1.1.1', auth.setupCode!)
    const key = base32Decode(secret)
    const code = () => totp(key, Math.floor(Date.now() / 30_000))

    await expect(auth.finishSetup('1.1.1.1', { setupCode: auth.setupCode!, username: 'admin', password: 'court', code: code() })).rejects.toThrow(/trop court/)
    const token = await auth.finishSetup('1.1.1.1', { setupCode: auth.setupCode!, username: 'admin', password: 'un mot de passe long', code: code() })
    expect(auth.session(token)?.username).toBe('admin')
    await expect(auth.startSetup('1.1.1.1', auth.setupCode!)).rejects.toThrow(/existe déjà/)

    // Le code déjà utilisé pour l'installation est refusé (rejeu).
    await expect(auth.login('2.2.2.2', { username: 'admin', password: 'un mot de passe long', code: code() })).rejects.toThrow(/incorrect/)
    auth.logout(token)
    expect(auth.session(token)).toBeNull()

    // 5 échecs : adresse bloquée, même avec les bons identifiants.
    for (let i = 0; i < 5; i++) await expect(auth.login('3.3.3.3', { username: 'admin', password: 'faux', code: '000000' })).rejects.toThrow()
    await expect(auth.login('3.3.3.3', { username: 'admin', password: 'un mot de passe long', code: code() })).rejects.toThrow(/Trop de tentatives/)
  }, 20_000)
})
