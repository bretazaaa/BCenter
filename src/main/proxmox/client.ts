import https from 'node:https'
import type { GuestInfo, MetricTimeframe, PowerAction, RemoteTask, ServerProfile } from '@shared/types'
import type { ScopedLogger } from '../core/logger'
import { secretKeys, type SecretStore } from '../data/secrets'
import type { GuestRef, VirtualizationProvider } from '../services/provider'
import * as parse from './parser'
import { PinnedAgent, probeCertificate } from './tls'

export class ProxmoxApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

const guestPath = (g: GuestRef) => `nodes/${encodeURIComponent(g.node)}/${g.kind}/${g.vmid}`
const refOf = (g: GuestInfo): GuestRef => ({ node: g.node, kind: g.kind, vmid: g.vmid })

/** Client de l'API REST Proxmox VE (authentification par jeton API). */
export class ProxmoxProvider implements VirtualizationProvider {
  private readonly agents = new Map<string, PinnedAgent>()

  constructor(
    private readonly secrets: SecretStore,
    private readonly log: ScopedLogger,
  ) {}

  probeCertificate(host: string, port: number) {
    return probeCertificate(host, port)
  }

  async testConnection(server: ServerProfile, secret?: string) {
    const version = (await this.request(server, 'GET', 'version', undefined, secret)) as { version?: string; release?: string }
    // /version répond à tout jeton valide : on vérifie aussi l'accès à l'inventaire.
    await this.request(server, 'GET', 'cluster/resources?type=node', undefined, secret)
    return { version: `Proxmox VE ${version.version ?? '?'}` }
  }

  async getSnapshot(server: ServerProfile, signal?: AbortSignal) {
    const snapshot = parse.parseClusterResources(server, await this.request(server, 'GET', 'cluster/resources', undefined, undefined, signal))
    snapshot.nodes = await Promise.all(
      snapshot.nodes.map(async (node) => {
        if (node.status !== 'online') return node
        try {
          const status = (await this.request(server, 'GET', `nodes/${encodeURIComponent(node.name)}/status`, undefined, undefined, signal)) as { pveversion?: string }
          return { ...node, version: status.pveversion }
        } catch {
          return node
        }
      }),
    )
    return snapshot
  }

  async getNodeMetrics(server: ServerProfile, node: string, timeframe: MetricTimeframe) {
    return parse.parseRrd(await this.request(server, 'GET', `nodes/${encodeURIComponent(node)}/rrddata?timeframe=${timeframe}&cf=AVERAGE`), false)
  }

  async getGuestMetrics(server: ServerProfile, guest: GuestRef, timeframe: MetricTimeframe) {
    return parse.parseRrd(await this.request(server, 'GET', `${guestPath(guest)}/rrddata?timeframe=${timeframe}&cf=AVERAGE`), true)
  }

  async getRecentTasks(server: ServerProfile, limit: number) {
    return parse.parseTasks(await this.request(server, 'GET', 'cluster/tasks')).sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
  }

  async powerAction(server: ServerProfile, guest: GuestInfo, action: PowerAction) {
    return this.taskId(await this.request(server, 'POST', `${guestPath(refOf(guest))}/status/${action}`, {}))
  }

  async guestAddresses(server: ServerProfile, guest: GuestInfo) {
    try {
      if (guest.kind === 'lxc') return parse.parseLxcInterfaces(await this.request(server, 'GET', `${guestPath(refOf(guest))}/interfaces`))
      return parse.parseQemuAgentAddresses(await this.request(server, 'GET', `${guestPath(refOf(guest))}/agent/network-get-interfaces`))
    } catch (error) {
      // Agent QEMU absent ou invité arrêté : aucune adresse découvrable.
      this.log.debug(`Adresses indisponibles pour ${guest.name} : ${(error as Error).message}`)
      return []
    }
  }

  async listSnapshots(server: ServerProfile, guest: GuestRef) {
    return parse.parseSnapshots(await this.request(server, 'GET', `${guestPath(guest)}/snapshot`))
  }

  async createSnapshot(server: ServerProfile, guest: GuestRef, name: string, description: string) {
    // Sans état mémoire : snapshot rapide, suffisant avant une mise à jour de paquets.
    const body: Record<string, string> = { snapname: name, description }
    if (guest.kind === 'qemu') body.vmstate = '0'
    return this.taskId(await this.request(server, 'POST', `${guestPath(guest)}/snapshot`, body))
  }

  async rollbackSnapshot(server: ServerProfile, guest: GuestRef, name: string) {
    return this.taskId(await this.request(server, 'POST', `${guestPath(guest)}/snapshot/${encodeURIComponent(name)}/rollback`, { start: '1' }))
  }

  async deleteSnapshot(server: ServerProfile, guest: GuestRef, name: string) {
    return this.taskId(await this.request(server, 'DELETE', `${guestPath(guest)}/snapshot/${encodeURIComponent(name)}`))
  }

  async waitForTask(server: ServerProfile, node: string, taskId: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RemoteTask> {
    const base = `nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(taskId)}`
    let next = 0
    let delay = 1000
    for (;;) {
      signal?.throwIfAborted()
      if (onLine) {
        for (const line of (await this.request(server, 'GET', `${base}/log?start=${next}&limit=500`)) as { n: number; t: string }[]) {
          next = Math.max(next, Number(line.n))
          if (line.t && line.t !== 'no content') onLine(line.t)
        }
      }
      const status = (await this.request(server, 'GET', `${base}/status`)) as { status?: string; exitstatus?: string; type?: string; starttime?: number }
      if (status.status === 'stopped') {
        return {
          id: taskId,
          node,
          type: status.type ?? '?',
          startedAt: (status.starttime ?? 0) * 1000,
          endedAt: Date.now(),
          state: parse.taskState(status.exitstatus, true),
          exitStatus: status.exitstatus,
        }
      }
      await sleep(delay, signal)
      delay = Math.min(5000, delay + 500)
    }
  }

  /** Oublie le client HTTPS d'un serveur (profil modifié ou supprimé). */
  invalidate(serverId: string) {
    for (const [key, agent] of this.agents) {
      if (key.startsWith(`${serverId}|`)) {
        agent.destroy()
        this.agents.delete(key)
      }
    }
  }

  private taskId(data: unknown): string {
    if (typeof data !== 'string') throw new ProxmoxApiError(200, "Proxmox n'a pas retourné d'identifiant de tâche.")
    return data
  }

  private agentFor(server: ServerProfile): PinnedAgent {
    const key = `${server.id}|${server.host}|${server.port}|${server.pinnedFingerprint}`
    let agent = this.agents.get(key)
    if (!agent) {
      this.invalidate(server.id)
      agent = new PinnedAgent(server.pinnedFingerprint)
      this.agents.set(key, agent)
    }
    return agent
  }

  private request(server: ServerProfile, method: 'GET' | 'POST' | 'DELETE', path: string, body?: Record<string, string>, secretOverride?: string, signal?: AbortSignal): Promise<unknown> {
    const secret = secretOverride ?? this.secrets.get(secretKeys.serverToken(server.id))
    if (!secret) return Promise.reject(new Error(`Aucun jeton API enregistré pour ${server.name}.`))

    // Un test (secret non enregistré) utilise un agent éphémère.
    const agent = secretOverride ? new PinnedAgent(server.pinnedFingerprint) : this.agentFor(server)
    const payload = body ? new URLSearchParams(body).toString() : undefined

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: server.host,
          port: server.port,
          path: `/api2/json/${path}`,
          method,
          agent,
          timeout: 30_000,
          signal,
          headers: {
            Authorization: `PVEAPIToken=${server.tokenId}=${secret}`,
            Accept: 'application/json',
            'User-Agent': 'BCenter',
            ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            if (secretOverride) agent.destroy()
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              reject(
                new ProxmoxApiError(
                  status,
                  status === 401
                    ? "Authentification refusée : vérifiez l'identifiant et le secret du jeton API."
                    : status === 403
                      ? 'Permissions insuffisantes pour ce jeton API.'
                      : `Erreur Proxmox ${status} : ${res.statusMessage ?? ''}`.trim(),
                ),
              )
              return
            }
            try {
              resolve((JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown }).data ?? null)
            } catch (error) {
              reject(error)
            }
          })
        },
      )
      req.on('timeout', () => req.destroy(new Error('Le serveur ne répond pas (délai dépassé).')))
      req.on('error', (error) => {
        if (secretOverride) agent.destroy()
        reject(error)
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason ?? new Error('Opération annulée.'))
      },
      { once: true },
    )
  })
}
