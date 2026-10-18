import http from 'node:http'
import https from 'node:https'
import type { NasProfile } from '@shared/types'
import { PinnedAgent } from '../proxmox/tls'

export interface HttpResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

export class NasHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface RequestOptions {
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/**
 * Client HTTP(S) d'un NAS. En HTTPS, le certificat est validé par Windows ou comparé à l'empreinte
 * approuvée avant l'envoi de la moindre donnée (mêmes règles que pour Proxmox).
 */
export class HttpClient {
  readonly agent: http.Agent

  constructor(readonly nas: Pick<NasProfile, 'host' | 'port' | 'protocol' | 'pinnedFingerprint'>) {
    this.agent = nas.protocol === 'https' ? new PinnedAgent(nas.pinnedFingerprint) : new http.Agent({ keepAlive: true, maxSockets: 6 })
  }

  get origin(): string {
    const host = this.nas.host.includes(':') && !this.nas.host.startsWith('[') ? `[${this.nas.host}]` : this.nas.host
    return `${this.nas.protocol}://${host}:${this.nas.port}`
  }

  request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    const transport = this.nas.protocol === 'https' ? https : http
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          host: this.nas.host,
          port: this.nas.port,
          path,
          method,
          agent: this.agent,
          timeout: options.timeoutMs ?? 25_000,
          signal: options.signal,
          headers: {
            'User-Agent': 'BCenter',
            Accept: 'application/json, text/xml;q=0.9, */*;q=0.5',
            ...options.headers,
            ...(options.body != null ? { 'Content-Length': String(Buffer.byteLength(options.body)) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
          res.on('error', reject)
        },
      )
      req.on('timeout', () => req.destroy(new Error('Le NAS ne répond pas (délai dépassé).')))
      req.on('error', reject)
      if (options.body != null) req.write(options.body)
      req.end()
    })
  }

  /** Requête JSON : lève une erreur explicite pour les statuts HTTP non 2xx. */
  async json<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, path, options)
    if (res.status < 200 || res.status >= 300) throw new NasHttpError(res.status, httpErrorMessage(res))
    try {
      return JSON.parse(res.body) as T
    } catch {
      throw new Error('Réponse inattendue du NAS (JSON invalide).')
    }
  }

  close(): void {
    this.agent.destroy()
  }
}

export function httpErrorMessage(res: HttpResponse): string {
  if (res.status === 401) return 'Authentification refusée : vérifiez les identifiants.'
  if (res.status === 403) return 'Permissions insuffisantes pour ce compte ou ce jeton.'
  if (res.status === 404) return 'Point d’accès introuvable : vérifiez le type de NAS, l’adresse et le port.'
  return `Erreur HTTP ${res.status}`
}

export const form = (params: Record<string, string | number | boolean | undefined>) =>
  new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]): [string, string] => [k, String(v)])).toString()

// ------------------------------------------------------------------ Lecture tolérante des réponses

export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : typeof v === 'number' ? String(v) : undefined)

export const arr = <T = Record<string, unknown>>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Date en millisecondes : nombre (s ou ms), chaîne ISO ou objet `{ $date }` (TrueNAS). */
export function time(v: unknown): number | undefined {
  if (v && typeof v === 'object' && '$date' in v) return time((v as { $date: unknown }).$date)
  if (typeof v === 'number' && v > 0) return v < 1e11 ? v * 1000 : v
  if (typeof v === 'string' && v) {
    const n = Number(v)
    if (Number.isFinite(n)) return time(n)
    const t = Date.parse(v.replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3'))
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

export const stripHtml = (v: string) => v.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

/** Exécute une lecture facultative : la fonctionnalité peut ne pas exister sur cette version du NAS. */
export async function optional<T>(read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read()
  } catch {
    return fallback
  }
}
