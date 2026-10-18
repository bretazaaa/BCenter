import type { AggregateSample, InfraSnapshot, InfraState, ServerProfile } from '@shared/types'
import type { ScopedLogger } from '../core/logger'
import type { ServerRepository, SettingsRepository } from '../data/repositories'
import type { AlertEngine } from './alerts'
import type { VirtualizationProvider } from './provider'

const MAX_HISTORY = 240

/**
 * Interroge périodiquement les serveurs et conserve le dernier état connu.
 * Tourne tant que BCenter est lancé, y compris fenêtre masquée dans la zone de notification.
 */
export class InfrastructureMonitor {
  private servers: ServerProfile[] = []
  private snapshots = new Map<string, InfraSnapshot>()
  private history: AggregateSample[] = []
  private lastCounters = new Map<string, { netIn: number; netOut: number; at: number }>()
  private lastRefresh: string | null = null
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  private stopped = false
  private readonly listeners = new Set<(state: InfraState) => void>()

  constructor(
    private readonly provider: VirtualizationProvider,
    private readonly serverRepo: ServerRepository,
    private readonly settings: SettingsRepository,
    private readonly alerts: AlertEngine,
    private readonly log: ScopedLogger,
  ) {}

  onChange(listener: (state: InfraState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get state(): InfraState {
    return { servers: this.servers, snapshots: [...this.snapshots.values()], history: this.history, lastRefresh: this.lastRefresh }
  }

  findServer(id: string): ServerProfile | undefined {
    return this.servers.find((s) => s.id === id)
  }

  reloadServers(): void {
    this.servers = this.serverRepo.list()
    for (const id of [...this.snapshots.keys()]) if (!this.servers.some((s) => s.id === id)) this.snapshots.delete(id)
  }

  /** Actualise immédiatement (les appels concurrents partagent la même actualisation). */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  start(): void {
    this.stopped = false
    const loop = async () => {
      if (this.stopped) return
      await this.refresh().catch((e) => this.log.error('Échec du cycle de surveillance', e))
      if (this.stopped) return
      const seconds = Math.min(600, Math.max(5, this.settings.value.refreshInterval))
      this.timer = setTimeout(loop, seconds * 1000)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  private async doRefresh(): Promise<void> {
    const results = await Promise.all(this.servers.map((s) => this.fetch(s)))
    this.snapshots = new Map(results.map((r) => [r.server.id, r]))
    this.appendHistory(results)
    this.lastRefresh = new Date().toISOString()
    this.alerts.evaluate(results, this.settings.value)
    const state = this.state
    for (const l of this.listeners) l(state)
  }

  private async fetch(server: ServerProfile): Promise<InfraSnapshot> {
    try {
      return await this.provider.getSnapshot(server, AbortSignal.timeout(20_000))
    } catch (error) {
      const message = (error as Error).name === 'TimeoutError' ? 'Délai de réponse dépassé.' : (error as Error).message
      this.log.warn(`Serveur ${server.name} injoignable : ${message}`)
      return { server, timestamp: new Date().toISOString(), reachable: false, error: message, nodes: [], guests: [], storages: [] }
    }
  }

  private appendHistory(results: InfraSnapshot[]): void {
    const nodes = results.filter((r) => r.reachable).flatMap((r) => r.nodes).filter((n) => n.status === 'online')
    if (nodes.length === 0) return

    const cpus = nodes.reduce((s, n) => s + n.cpuCount, 0)
    const cpu = cpus > 0 ? nodes.reduce((s, n) => s + n.cpu * n.cpuCount, 0) / cpus : 0
    const memTotal = nodes.reduce((s, n) => s + n.memTotal, 0)
    const mem = memTotal > 0 ? nodes.reduce((s, n) => s + n.memUsed, 0) / memTotal : 0

    // Compteurs réseau cumulés côté Proxmox : on calcule un débit depuis l'échantillon précédent.
    const now = Date.now()
    let netIn = 0
    let netOut = 0
    const counters = new Map<string, { netIn: number; netOut: number; at: number }>()
    for (const g of results.flatMap((r) => r.guests).filter((g) => g.status === 'running')) {
      const key = `${g.serverId}/${g.vmid}`
      counters.set(key, { netIn: g.netIn, netOut: g.netOut, at: now })
      const prev = this.lastCounters.get(key)
      if (prev && now > prev.at) {
        const seconds = (now - prev.at) / 1000
        netIn += Math.max(0, g.netIn - prev.netIn) / seconds
        netOut += Math.max(0, g.netOut - prev.netOut) / seconds
      }
    }
    const first = this.lastCounters.size === 0
    this.lastCounters = counters
    this.history = [...this.history, { time: now, cpu, mem, netIn: first ? Number.NaN : netIn, netOut: first ? Number.NaN : netOut }].slice(-MAX_HISTORY)
  }
}
