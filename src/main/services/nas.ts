import type { NasAction, NasProfile, NasSample, NasSnapshot, NasState } from '@shared/types'
import type { ScopedLogger } from '../core/logger'
import type { NasRepository, SettingsRepository } from '../data/repositories'
import { secretKeys, type SecretStore } from '../data/secrets'
import { emptyData, type NasDriver, type NasDriverFactory, type NasSecrets } from '../nas/driver'
import type { AlertEngine } from './alerts'

/** Intervalle minimal entre deux lectures d'un NAS (certaines API sont coûteuses). */
const MIN_INTERVAL_S = 30
/** Durée d'historique conservée en mémoire pour le monitoring. */
const HISTORY_MS = 24 * 3600_000

/**
 * Surveille les NAS enregistrés et exécute les actions demandées. Un pilote (et sa session) est conservé
 * par NAS tant que son profil ne change pas.
 */
export class NasMonitor {
  private systems: NasProfile[] = []
  private snapshots = new Map<string, NasSnapshot>()
  private readonly samples = new Map<string, NasSample[]>()
  private readonly drivers = new Map<string, { key: string; driver: NasDriver }>()
  private lastRefresh: string | null = null
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null
  private stopped = false
  private readonly listeners = new Set<(state: NasState) => void>()

  constructor(
    private readonly repo: NasRepository,
    private readonly secrets: SecretStore,
    private readonly settings: SettingsRepository,
    private readonly alerts: AlertEngine,
    private readonly factory: NasDriverFactory,
    private readonly log: ScopedLogger,
  ) {}

  onChange(listener: (state: NasState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get state(): NasState {
    return { systems: this.systems, snapshots: this.systems.map((s) => this.snapshots.get(s.id)).filter((s): s is NasSnapshot => !!s), lastRefresh: this.lastRefresh }
  }

  reload(): void {
    this.systems = this.repo.list()
    for (const [id, entry] of [...this.drivers]) {
      if (!this.systems.some((s) => s.id === id)) {
        entry.driver.close()
        this.drivers.delete(id)
        this.snapshots.delete(id)
        this.samples.delete(id)
      }
    }
    this.emit()
  }

  /** Oublie la session d'un NAS (identifiants modifiés). */
  invalidate(id: string): void {
    this.drivers.get(id)?.driver.close()
    this.drivers.delete(id)
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null))
    return this.refreshing
  }

  start(): void {
    this.stopped = false
    const loop = async () => {
      if (this.stopped) return
      await this.refresh().catch((e) => this.log.error('Échec de la surveillance des NAS', e))
      if (this.stopped) return
      const seconds = Math.min(600, Math.max(MIN_INTERVAL_S, this.settings.value.refreshInterval))
      this.timer = setTimeout(loop, seconds * 1000)
    }
    void loop()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    for (const { driver } of this.drivers.values()) driver.close()
    this.drivers.clear()
  }

  async action(id: string, action: NasAction): Promise<string> {
    const nas = this.systems.find((s) => s.id === id)
    if (!nas) throw new Error('NAS introuvable.')
    const message = await this.driverFor(nas).action(action)
    this.log.info(`${nas.name} : ${describe(action)} — ${message}`)
    // Laisse le NAS appliquer l'action avant de relire son état.
    setTimeout(() => void this.refresh(), action.kind === 'power' ? 5000 : 2500)
    return message
  }

  private async doRefresh(): Promise<void> {
    if (this.systems.length === 0) {
      this.lastRefresh = new Date().toISOString()
      this.alerts.evaluateNas([], this.settings.value)
      this.emit()
      return
    }
    const results = await Promise.all(this.systems.map((s) => this.fetch(s)))
    this.snapshots = new Map(results.map((r) => [r.nas.id, r]))
    for (const r of results.filter((x) => x.reachable)) this.record(r)
    this.lastRefresh = new Date().toISOString()
    this.alerts.evaluateNas(results, this.settings.value)
    this.emit()
  }

  history(id: string): NasSample[] {
    return this.samples.get(id) ?? []
  }

  private record(s: NasSnapshot): void {
    const pools = s.pools.filter((p) => p.kind !== 'raid')
    const temps = s.disks.map((d) => d.temperature).filter((t): t is number => t != null)
    const sample: NasSample = {
      time: Date.now(),
      cpu: s.system.cpu,
      memUsed: s.system.memUsed,
      memTotal: s.system.memTotal,
      storageUsed: pools.reduce((n, p) => n + p.used, 0),
      storageTotal: pools.reduce((n, p) => n + p.total, 0),
      temperature: s.system.temperature,
      diskTemperature: temps.length ? Math.max(...temps) : undefined,
    }
    const cutoff = sample.time - HISTORY_MS
    this.samples.set(s.nas.id, [...(this.samples.get(s.nas.id) ?? []).filter((x) => x.time >= cutoff), sample])
  }

  private async fetch(nas: NasProfile): Promise<NasSnapshot> {
    const timestamp = new Date().toISOString()
    try {
      const data = await withTimeout(this.driverFor(nas).snapshot(), 30_000)
      return { nas, timestamp, reachable: true, ...data }
    } catch (error) {
      const message = (error as Error).message
      this.log.warn(`NAS ${nas.name} injoignable : ${message}`)
      // Une session corrompue est recréée au prochain cycle.
      this.invalidate(nas.id)
      return { nas, timestamp, reachable: false, error: message, ...emptyData() }
    }
  }

  private driverFor(nas: NasProfile): NasDriver {
    const key = JSON.stringify([nas.kind, nas.host, nas.port, nas.protocol, nas.username, nas.pinnedFingerprint])
    const current = this.drivers.get(nas.id)
    if (current?.key === key) return current.driver
    current?.driver.close()
    const secret = this.secrets.get(secretKeys.nasSecret(nas.id))
    if (!secret) throw new Error(`Aucun secret enregistré pour ${nas.name}.`)
    const secrets: NasSecrets = { secret, deviceToken: this.secrets.get(secretKeys.nasDevice(nas.id)) }
    const driver = this.factory(nas, secrets)
    this.drivers.set(nas.id, { key, driver })
    return driver
  }

  private emit(): void {
    const state = this.state
    for (const l of this.listeners) l(state)
  }
}

function describe(action: NasAction): string {
  switch (action.kind) {
    case 'service': return `service ${action.id} (${action.op})`
    case 'app': return `application ${action.id} (${action.op})`
    case 'task': return `tâche ${action.id}`
    case 'scrub': return `scrub ${action.poolId}`
    case 'update': return 'mise à jour du système'
    case 'power': return action.op === 'reboot' ? 'redémarrage' : 'arrêt'
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Délai de réponse dépassé.')), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e as Error)
      },
    )
  })
}

