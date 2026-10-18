import { createHash, timingSafeEqual } from 'node:crypto'
import https from 'node:https'
import type { Duplex } from 'node:stream'
import tls from 'node:tls'
import type { CertificateInfo } from '@shared/types'

export function normalizeFingerprint(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toUpperCase()
}

/** Format « AB:CD:EF… » identique à celui affiché par Proxmox. */
export function formatFingerprint(value: string): string {
  return (normalizeFingerprint(value).match(/.{2}/g) ?? []).join(':')
}

export function fingerprintsMatch(pinned: string | null, actual: string): boolean {
  if (!pinned) return false
  const a = Buffer.from(normalizeFingerprint(pinned))
  const b = Buffer.from(normalizeFingerprint(actual))
  return a.length === b.length && timingSafeEqual(a, b)
}

function certFingerprint(cert: tls.PeerCertificate): string {
  return createHash('sha256').update(cert.raw).digest('hex').toUpperCase()
}

/**
 * Agent HTTPS à validation stricte : le certificat doit être reconnu par le système (chaîne + nom)
 * OU correspondre exactement à l'empreinte approuvée par l'utilisateur.
 * La vérification a lieu avant qu'aucun octet HTTP (et donc aucun jeton) ne soit envoyé.
 */
export class PinnedAgent extends https.Agent {
  constructor(private readonly pinned: string | null) {
    super({ keepAlive: true, maxSockets: 8, timeout: 30_000 })
  }

  override createConnection(options: tls.ConnectionOptions, callback?: (err: Error | null, socket: Duplex) => void): Duplex {
    const host = options.servername ?? options.host ?? ''
    const socket = tls.connect({ ...options, rejectUnauthorized: false, servername: host })
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const systemOk = socket.authorized && !tls.checkServerIdentity(host, cert)
      if (systemOk || fingerprintsMatch(this.pinned, certFingerprint(cert))) {
        callback?.(null, socket)
      } else {
        const error = new Error('Certificat TLS non approuvé : son empreinte ne correspond pas à celle enregistrée pour ce serveur.')
        socket.destroy(error)
        callback?.(error, socket)
      }
    })
    socket.once('error', (error) => callback?.(error, socket))
    return undefined as unknown as Duplex
  }
}

/** Lit le certificat présenté par le serveur (aucune donnée applicative n'est échangée). */
export function probeCertificate(host: string, port: number, timeoutMs = 10_000): Promise<CertificateInfo> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs })
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate()
      const identityError = socket.authorized ? tls.checkServerIdentity(host, cert) : undefined
      socket.end()
      if (!cert?.raw) {
        reject(new Error("Le serveur n'a présenté aucun certificat."))
        return
      }
      resolve({
        subject: formatDn(cert.subject),
        issuer: formatDn(cert.issuer),
        fingerprint: certFingerprint(cert),
        validFrom: new Date(cert.valid_from).toISOString(),
        validTo: new Date(cert.valid_to).toISOString(),
        trustedBySystem: socket.authorized && !identityError,
        validationError: socket.authorized ? identityError?.message : String(socket.authorizationError ?? ''),
      })
    })
    socket.once('timeout', () => socket.destroy(new Error('Le serveur ne répond pas (délai dépassé).')))
    socket.once('error', reject)
  })
}

function formatDn(dn: tls.PeerCertificate['subject'] | undefined): string {
  if (!dn) return ''
  return Object.entries(dn)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : v}`)
    .join(', ')
}
