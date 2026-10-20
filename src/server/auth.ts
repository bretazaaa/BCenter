import { randomBytes, randomInt } from 'node:crypto'
import QRCode from 'qrcode'
import type { Database } from '../main/data/database'
import type { SecretStore } from '../main/data/secrets'
import { base32Decode, base32Encode, hashPassword, verifyPassword, verifyTotp } from './crypto'

interface Admin {
  username: string
  passwordHash: string
  /** Dernier pas TOTP accepté : un code déjà utilisé est refusé. */
  lastStep: number
}

interface Session {
  username: string
  created: number
  lastSeen: number
}

const SESSION_IDLE_MS = 12 * 3600_000
const SESSION_MAX_MS = 7 * 86_400_000
const TOTP_KEY = 'web:totp'
const MIN_PASSWORD = 12

export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * Authentification de l'interface web : un compte administrateur (mot de passe scrypt + code TOTP),
 * des sessions aléatoires côté serveur et une limitation des tentatives par adresse.
 */
export class AuthService {
  private readonly sessions = new Map<string, Session>()
  private readonly failures = new Map<string, { count: number; lockedUntil: number }>()
  private pendingTotp: Buffer | null = null
  /** Code d'installation affiché dans les journaux du serveur : seul l'administrateur du serveur peut créer le compte. */
  readonly setupCode: string | null

  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
  ) {
    this.setupCode = this.admin ? null : `${randomInt(1000, 9999)}-${randomInt(1000, 9999)}-${randomInt(1000, 9999)}`
  }

  get admin(): Admin | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'web-admin'").get() as { value: string } | undefined
    return row ? (JSON.parse(row.value) as Admin) : null
  }

  private saveAdmin(admin: Admin) {
    this.db.prepare("INSERT INTO settings(key, value) VALUES ('web-admin', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(admin))
  }

  /** Étape 1 de l'installation : génère le secret TOTP à enregistrer dans l'application d'authentification. */
  async startSetup(ip: string, setupCode: string) {
    this.checkLock(ip)
    if (this.admin) throw new AuthError(409, 'Le compte administrateur existe déjà.')
    if (!this.setupCode || setupCode.trim() !== this.setupCode) {
      this.fail(ip)
      throw new AuthError(403, 'Code d’installation incorrect : il est affiché dans les journaux du serveur BCenter au démarrage.')
    }
    this.pendingTotp = randomBytes(20)
    const secret = base32Encode(this.pendingTotp)
    const uri = `otpauth://totp/BCenter?secret=${secret}&issuer=BCenter&algorithm=SHA1&digits=6&period=30`
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#0b0c10', light: '#ffffff' } }) }
  }

  /** Étape 2 : crée le compte si le premier code TOTP est correct, puis ouvre une session. */
  async finishSetup(ip: string, input: { setupCode: string; username: string; password: string; code: string }): Promise<string> {
    this.checkLock(ip)
    if (this.admin) throw new AuthError(409, 'Le compte administrateur existe déjà.')
    if (!this.setupCode || input.setupCode.trim() !== this.setupCode || !this.pendingTotp) {
      this.fail(ip)
      throw new AuthError(403, 'Installation expirée : recommencez.')
    }
    const username = input.username.trim()
    if (!/^[\w.@-]{3,64}$/.test(username)) throw new AuthError(400, 'Nom d’utilisateur : 3 à 64 caractères (lettres, chiffres, . _ - @).')
    if (input.password.length < MIN_PASSWORD) throw new AuthError(400, `Mot de passe trop court : ${MIN_PASSWORD} caractères au minimum.`)
    const step = verifyTotp(this.pendingTotp, input.code.trim(), 0)
    if (step === null) {
      this.fail(ip)
      throw new AuthError(400, 'Code de validation incorrect : vérifiez l’heure de votre téléphone et réessayez.')
    }
    this.secrets.set(TOTP_KEY, base32Encode(this.pendingTotp))
    this.saveAdmin({ username, passwordHash: await hashPassword(input.password), lastStep: step })
    this.pendingTotp = null
    return this.createSession(username)
  }

  async login(ip: string, input: { username: string; password: string; code: string }): Promise<string> {
    this.checkLock(ip)
    const admin = this.admin
    const totpSecret = this.secrets.get(TOTP_KEY)
    // Vérification complète même si l'utilisateur est inconnu : pas d'indice sur les noms valides.
    const passwordOk = admin ? await verifyPassword(input.password, admin.passwordHash) : (await hashPassword(input.password), false)
    const userOk = !!admin && admin.username === input.username.trim()
    const step = admin && totpSecret ? verifyTotp(base32Decode(totpSecret), input.code.trim(), admin.lastStep) : null
    if (!admin || !userOk || !passwordOk || step === null) {
      this.fail(ip)
      throw new AuthError(401, 'Identifiant, mot de passe ou code incorrect.')
    }
    this.failures.delete(ip)
    this.saveAdmin({ ...admin, lastStep: step })
    return this.createSession(admin.username)
  }

  /** Session valide (et prolongée) ou null. */
  session(token: string | undefined): Session | null {
    if (!token) return null
    const s = this.sessions.get(token)
    if (!s) return null
    const now = Date.now()
    if (now - s.lastSeen > SESSION_IDLE_MS || now - s.created > SESSION_MAX_MS) {
      this.sessions.delete(token)
      return null
    }
    s.lastSeen = now
    return s
  }

  logout(token: string | undefined) {
    if (token) this.sessions.delete(token)
  }

  private createSession(username: string): string {
    const token = randomBytes(32).toString('base64url')
    this.sessions.set(token, { username, created: Date.now(), lastSeen: Date.now() })
    return token
  }

  private checkLock(ip: string) {
    const f = this.failures.get(ip)
    if (f && f.lockedUntil > Date.now()) {
      throw new AuthError(429, `Trop de tentatives : réessayez dans ${Math.ceil((f.lockedUntil - Date.now()) / 60_000)} min.`)
    }
  }

  /** 5 échecs : blocage de 5 min, puis durée doublée à chaque nouvel échec (24 h au plus). */
  private fail(ip: string) {
    const f = this.failures.get(ip) ?? { count: 0, lockedUntil: 0 }
    f.count++
    if (f.count >= 5) f.lockedUntil = Date.now() + Math.min(24 * 3600_000, 5 * 60_000 * 2 ** (f.count - 5))
    this.failures.set(ip, f)
  }
}
