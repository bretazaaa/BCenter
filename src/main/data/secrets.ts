import type { Database } from './database'

/**
 * Chiffrement des secrets. En production : Electron safeStorage, qui s'appuie sur Windows DPAPI
 * (clé liée au compte Windows de l'utilisateur).
 */
export interface SecretCipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export const secretKeys = {
  serverToken: (serverId: string) => `server:${serverId}:token`,
  sshPassword: (credentialId: string) => `ssh:${credentialId}:password`,
  sshPassphrase: (credentialId: string) => `ssh:${credentialId}:passphrase`,
  nasSecret: (nasId: string) => `nas:${nasId}:secret`,
  /** Jeton d'appareil approuvé après une validation en deux étapes (Synology). */
  nasDevice: (nasId: string) => `nas:${nasId}:device`,
}

/** Coffre de secrets : seul le blob chiffré est écrit dans SQLite. */
export class SecretStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: SecretCipher,
  ) {}

  selfTest(): boolean {
    if (!this.cipher.isAvailable()) return false
    try {
      return this.cipher.decrypt(this.cipher.encrypt('bcenter-selftest')) === 'bcenter-selftest'
    } catch {
      return false
    }
  }

  set(key: string, secret: string): void {
    const data = this.cipher.encrypt(secret)
    this.db
      .prepare(
        `INSERT INTO secrets(key, protected, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET protected = excluded.protected, updated_at = excluded.updated_at`,
      )
      .run(key, data, new Date().toISOString())
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT protected FROM secrets WHERE key = ?').get(key) as { protected: Uint8Array } | undefined
    return row ? this.cipher.decrypt(Buffer.from(row.protected)) : null
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
  }
}
