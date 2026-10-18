import type { Alert, AlertSeverity, AppSettings, InfraSnapshot, NasSnapshot, SshTarget } from '@shared/types'

export type Notify = (title: string, body: string, severity: AlertSeverity) => void

const MAX_HISTORY = 500

/**
 * Transforme l'état de l'infrastructure en alertes. Une condition produit une alerte unique (clé stable),
 * résolue automatiquement lorsque la condition disparaît.
 */
export class AlertEngine {
  private readonly active = new Map<string, Alert>()
  private readonly history: Alert[] = []
  private readonly listeners = new Set<() => void>()

  constructor(private readonly notify: Notify) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  list(): { active: Alert[]; history: Alert[] } {
    const order: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 }
    return {
      active: [...this.active.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.raisedAt - a.raisedAt),
      history: [...this.history].sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)),
    }
  }

  evaluate(snapshots: InfraSnapshot[], settings: AppSettings): void {
    const current = new Map<string, Alert>()
    const add = (key: string, severity: AlertSeverity, title: string, message: string, source: string) =>
      current.set(key, { key, severity, title, message, source, raisedAt: Date.now(), acknowledged: false })

    for (const s of snapshots) {
      const server = s.server.name
      if (!s.reachable) {
        add(`server:${s.server.id}`, 'critical', 'Serveur injoignable', `${server} ne répond pas : ${s.error ?? 'erreur inconnue'}`, server)
        continue
      }
      for (const n of s.nodes) {
        const source = `${server} / ${n.name}`
        if (n.status !== 'online') {
          add(`node-offline:${s.server.id}:${n.name}`, 'critical', 'Nœud hors ligne', `Le nœud ${n.name} est hors ligne.`, source)
          continue
        }
        if (n.cpu >= settings.cpuThreshold) {
          add(`node-cpu:${s.server.id}:${n.name}`, 'warning', 'Charge CPU élevée', `${n.name} utilise ${pct(n.cpu)} du processeur.`, source)
        }
        const mem = n.memTotal ? n.memUsed / n.memTotal : 0
        if (mem >= settings.memThreshold) {
          add(`node-mem:${s.server.id}:${n.name}`, 'warning', 'Mémoire saturée', `${n.name} utilise ${pct(mem)} de sa mémoire.`, source)
        }
      }
      for (const st of s.storages.filter((x) => x.active && x.total > 0)) {
        const ratio = st.used / st.total
        if (ratio >= settings.storageThreshold) {
          add(`storage:${s.server.id}:${st.node}:${st.name}`, ratio >= 0.95 ? 'critical' : 'warning', 'Stockage presque plein',
            `${st.name} sur ${st.node} est rempli à ${pct(ratio)}.`, `${server} / ${st.node}`)
        }
      }
    }

    this.apply(current, (key) => !key.startsWith('maint:') && !key.startsWith('nas:'))
  }

  /** Alertes des NAS : accessibilité, santé des pools et disques, remplissage, alertes propres au NAS. */
  evaluateNas(snapshots: NasSnapshot[], settings: AppSettings): void {
    const current = new Map<string, Alert>()
    const add = (key: string, severity: AlertSeverity, title: string, message: string, source: string) =>
      current.set(key, { key, severity, title, message, source, raisedAt: Date.now(), acknowledged: false })

    for (const s of snapshots) {
      const id = s.nas.id
      const source = s.nas.name
      if (!s.reachable) {
        add(`nas:${id}:down`, 'critical', 'NAS injoignable', `${source} ne répond pas : ${s.error ?? 'erreur inconnue'}`, source)
        continue
      }
      for (const p of s.pools) {
        if (p.status === 'degraded') add(`nas:${id}:pool:${p.id}`, 'warning', 'Stockage dégradé', `${p.name} sur ${source} est dégradé${p.statusText ? ` (${p.statusText})` : ''}.`, source)
        else if (p.status === 'faulted' || p.status === 'offline') add(`nas:${id}:pool:${p.id}`, 'critical', 'Stockage hors service', `${p.name} sur ${source} est ${p.status === 'offline' ? 'hors ligne' : 'en panne'}${p.statusText ? ` (${p.statusText})` : ''}.`, source)
        const ratio = p.total > 0 ? p.used / p.total : 0
        if (ratio >= settings.storageThreshold) {
          add(`nas:${id}:full:${p.id}`, ratio >= 0.95 ? 'critical' : 'warning', 'Stockage presque plein', `${p.name} sur ${source} est rempli à ${pct(ratio)}.`, source)
        }
      }
      for (const d of s.disks) {
        if (d.health === 'failing') add(`nas:${id}:disk:${d.id}`, 'critical', 'Disque défaillant', `${d.name}${d.model ? ` (${d.model})` : ''} sur ${source} : ${d.healthText ?? 'défaillance détectée'}.`, source)
        else if (d.health === 'warning') add(`nas:${id}:disk:${d.id}`, 'warning', 'Disque à surveiller', `${d.name}${d.model ? ` (${d.model})` : ''} sur ${source} : ${d.healthText ?? 'avertissement'}.`, source)
      }
      for (const a of s.alerts.filter((x) => x.level !== 'info')) {
        add(`nas:${id}:native:${a.id}`, a.level, `Alerte ${source}`, a.message, source)
      }
      if (s.system.updates?.available) {
        add(`nas:${id}:update`, 'info', 'Mise à jour du NAS disponible', `${source} : ${s.system.updates.version ?? (s.system.updates.count ? `${s.system.updates.count} paquet(s)` : 'nouvelle version')} disponible.`, source)
      }
    }

    this.apply(current, (key) => key.startsWith('nas:'))
  }

  /** Signale qu'une machine maintenue doit être redémarrée (ou ne le doit plus). */
  setRebootRequired(target: Pick<SshTarget, 'id' | 'name'>, required: boolean): void {
    const key = `maint:reboot:${target.id}`
    const current = new Map([...this.active].filter(([k]) => k.startsWith('maint:') && k !== key))
    if (required) {
      current.set(key, this.active.get(key) ?? {
        key, severity: 'info', title: 'Redémarrage requis',
        message: `${target.name} doit être redémarré pour finaliser les mises à jour.`, source: target.name,
        raisedAt: Date.now(), acknowledged: false,
      })
    }
    this.apply(current, (k) => k.startsWith('maint:'))
  }

  acknowledge(key: string): void {
    const alert = this.active.get(key)
    if (alert) {
      this.active.set(key, { ...alert, acknowledged: true })
      this.emit()
    }
  }

  private apply(current: Map<string, Alert>, scope: (key: string) => boolean): void {
    let changed = false
    for (const [key, alert] of [...this.active]) {
      if (scope(key) && !current.has(key)) {
        this.active.delete(key)
        this.history.push({ ...alert, resolvedAt: Date.now() })
        changed = true
      }
    }
    for (const [key, alert] of current) {
      if (!this.active.has(key)) {
        this.active.set(key, alert)
        changed = true
        if (alert.severity !== 'info') this.notify(alert.title, alert.message, alert.severity)
      }
    }
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
    if (changed) this.emit()
  }

  private emit() {
    for (const l of this.listeners) l()
  }
}

const pct = (v: number) => `${Math.round(v * 100)} %`
