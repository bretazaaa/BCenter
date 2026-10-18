import type { NasAction, NasDisk, NasPool, NasProfile, NasTask } from '@shared/types'
import { emptyData, NasUnsupported, OP_LABEL, splitId, type NasData, type NasDriver, type NasSecrets } from './driver'
import { arr, form, HttpClient, NasHttpError, num, obj, optional, str, time } from './http'

type Row = Record<string, unknown>

const TASK_PATHS = { sync: 'sync', verify: 'verify', prune: 'prune' } as const

/** API REST de Proxmox Backup Server (jeton API, comme Proxmox VE). */
export class PbsDriver implements NasDriver {
  private readonly http: HttpClient

  constructor(
    private readonly nas: NasProfile,
    private readonly secrets: NasSecrets,
  ) {
    this.http = new HttpClient(nas)
  }

  async test() {
    const version = obj(await this.api('GET', 'version'))
    await this.api('GET', 'status/datastore-usage')
    return { version: `Proxmox Backup Server ${str(version.version) ?? ''}`.trim() }
  }

  async snapshot(): Promise<NasData> {
    const list = (path: string) => optional(async () => arr<Row>(await this.api('GET', path)), [] as Row[])
    const [version, status] = await Promise.all([this.api('GET', 'version').then(obj), this.api('GET', 'nodes/localhost/status').then(obj)])
    const [stores, disks, services, syncs, verifies, prunes, gcs, updates] = await Promise.all([
      list('status/datastore-usage'), list('nodes/localhost/disks/list'), list('nodes/localhost/services'),
      list('admin/sync'), list('admin/verify'), list('admin/prune'), list('admin/gc'), list('nodes/localhost/apt/update'),
    ])
    const data = emptyData()
    const memory = obj(status.memory)
    data.system = {
      hostname: str(obj(status.info).hostname),
      version: `Proxmox Backup Server ${str(version.version) ?? ''}${str(version.release) ? `-${version.release}` : ''}`.trim(),
      uptime: num(status.uptime),
      cpu: num(status.cpu),
      memTotal: num(memory.total),
      memUsed: num(memory.used),
      model: str(obj(status.cpuinfo).model),
      updates: { available: updates.length > 0, count: updates.length || undefined },
    }
    data.pools = stores.map((s): NasPool => ({
      id: str(s.store) ?? '?', name: str(s.store) ?? '?', kind: 'datastore', status: s.error ? 'faulted' : 'healthy', statusText: str(s.error),
      used: num(s.used) ?? 0, total: num(s.total) ?? 0, detail: 'Datastore', canScrub: false,
    }))
    data.disks = disks.map((d): NasDisk => {
      const health = str(d.health)?.toUpperCase()
      return {
        id: str(d.name) ?? '?', name: str(d.devpath) ?? str(d.name) ?? '?', model: str(d.model), serial: str(d.serial), size: num(d.size) ?? 0,
        health: health === 'PASSED' || health === 'OK' ? 'ok' : health === 'FAILED' ? 'failing' : health ? 'warning' : 'unknown',
        healthText: str(d.health), pool: str(d.used),
      }
    })
    data.services = services.map((s) => ({
      id: str(s.service) ?? '?', name: str(s.name) ?? str(s.service) ?? '?', running: s.state === 'running', enabled: s['unit-state'] === 'enabled',
      // Arrêter l'API ou le proxy couperait BCenter du serveur.
      controllable: !['proxmox-backup', 'proxmox-backup-proxy'].includes(str(s.service) ?? ''),
    }))
    const job = (type: NasTask['type'], name: (j: Row) => string, prefix: string) => (j: Row): NasTask => ({
      id: `${prefix}:${j.id ?? j.store}`, name: name(j), type, enabled: j.disable !== true,
      detail: str(j.comment) ?? str(j.schedule), lastRun: time(j['last-run-endtime']), state: runState(str(j['last-run-state'])), canRun: true,
    })
    data.tasks = [
      ...syncs.map(job('sync', (j) => `Synchronisation ${str(j.remote) ?? ''}/${str(j['remote-store']) ?? ''} → ${str(j.store) ?? ''}`, 'sync')),
      ...verifies.map(job('verify', (j) => `Vérification ${str(j.store) ?? ''}`, 'verify')),
      ...prunes.map(job('prune', (j) => `Élagage ${str(j.store) ?? ''}`, 'prune')),
      ...(gcs.length ? gcs : stores.map((s) => ({ store: s.store }))).map(job('gc', (j) => `Garbage collection ${str(j.store) ?? ''}`, 'gc')),
    ]
    data.capabilities = ['reboot', 'shutdown']
    return data
  }

  async action(action: NasAction): Promise<string> {
    switch (action.kind) {
      case 'service':
        await this.api('POST', `nodes/localhost/services/${encodeURIComponent(action.id)}/${action.op}`)
        return `${OP_LABEL[action.op]} du service ${action.id} demandé.`
      case 'task': {
        const [type, id] = splitId(action.id)
        if (type === 'gc') await this.api('POST', `admin/datastore/${encodeURIComponent(id)}/gc`)
        else if (type in TASK_PATHS) await this.api('POST', `admin/${TASK_PATHS[type as keyof typeof TASK_PATHS]}/${encodeURIComponent(id)}/run`)
        else throw new Error('Tâche inconnue.')
        return 'Tâche lancée sur Proxmox Backup Server.'
      }
      case 'power':
        await this.api('POST', 'nodes/localhost/status', { command: action.op })
        return action.op === 'reboot' ? 'Redémarrage du serveur demandé.' : 'Arrêt du serveur demandé.'
      case 'update':
        throw new NasUnsupported('L’installation des paquets par l’API (utilisez le centre de mises à jour via SSH)')
      default:
        throw new NasUnsupported('Cette action')
    }
  }

  close(): void {
    this.http.close()
  }

  private async api(method: 'GET' | 'POST', path: string, body?: Record<string, string>): Promise<unknown> {
    const payload = body ? form(body) : undefined
    const res = await this.http.json<{ data?: unknown }>(method, `/api2/json/${path}`, {
      body: payload,
      headers: {
        Authorization: `PBSAPIToken=${this.nas.username ?? ''}:${this.secrets.secret}`,
        ...(payload ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    }).catch((error: unknown) => {
      if (error instanceof NasHttpError && error.status === 401) throw new Error("Authentification refusée : vérifiez l'identifiant et le secret du jeton API.")
      throw error
    })
    return res.data ?? null
  }
}

function runState(state: string | undefined): NasTask['state'] {
  if (!state) return 'never'
  if (state === 'OK') return 'ok'
  if (/^WARNINGS?/.test(state)) return 'ok'
  if (state === 'running') return 'running'
  return 'failed'
}
