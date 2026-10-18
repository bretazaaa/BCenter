import type { NasAction, NasDisk, NasPool, NasProfile, NasShare, NasTask } from '@shared/types'
import { emptyData, NasUnsupported, splitId, type NasData, type NasDriver, type NasSecrets } from './driver'
import { arr, HttpClient, NasHttpError, httpErrorMessage, num, obj, optional, str } from './http'

type Row = Record<string, unknown>

class OmvError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

const LIST = { start: 0, limit: -1 }

/** API RPC d'OpenMediaVault (/rpc.php, OMV 5 à 7) avec session par cookie. */
export class OmvDriver implements NasDriver {
  private readonly http: HttpClient
  private cookie: string | null = null
  private login: Promise<void> | null = null

  constructor(
    private readonly nas: NasProfile,
    private readonly secrets: NasSecrets,
  ) {
    this.http = new HttpClient(nas)
  }

  async test() {
    const info = obj(await this.rpc('System', 'getInformation'))
    return { version: `OpenMediaVault ${str(info.version) ?? ''}`.trim() }
  }

  async snapshot(): Promise<NasData> {
    const call = (service: string, method: string, params: unknown = null) => optional(() => this.rpc(service, method, params), null as unknown)
    const rows = (v: unknown) => (Array.isArray(v) ? arr<Row>(v) : arr<Row>(obj(v).data))
    const info = obj(await this.rpc('System', 'getInformation'))
    const [filesystems, raids, smart, devices, smb, nfs, services, rsync, cron, upgrades] = await Promise.all([
      call('FileSystemMgmt', 'enumerateFilesystems'), call('RaidMgmt', 'getList', LIST), call('Smart', 'getList', LIST),
      call('DiskMgmt', 'enumerateDevices'), call('SMB', 'getShareList', LIST), call('NFS', 'getShareList', LIST),
      call('Services', 'getStatus'), call('Rsync', 'getList', LIST), call('Cron', 'getList', { ...LIST, type: ['userdefined'] }),
      call('Apt', 'getUpgradedList', LIST),
    ])

    const data = emptyData()
    const pending = rows(upgrades).length || num(info.availablePkgUpdates) || 0
    data.system = {
      hostname: str(info.hostname),
      model: str(info.cpuModelName),
      version: str(info.version) ? `OpenMediaVault ${info.version}` : undefined,
      uptime: num(info.uptime),
      cpu: num(info.cpuUtilization) != null ? (num(info.cpuUtilization) ?? 0) / 100 : undefined,
      memTotal: num(info.memTotal),
      memUsed: num(info.memUsed),
      rebootRequired: info.rebootRequired === true,
      updates: upgrades != null || info.pkgUpdatesAvailable != null ? { available: pending > 0 || info.pkgUpdatesAvailable === true, count: pending || undefined } : undefined,
    }
    data.pools = [...rows(raids).map(parseRaid), ...rows(filesystems).filter((f) => f.mounted !== false && str(f.type) !== 'swap').map(parseFilesystem)]
    const smartRows = rows(smart)
    data.disks = (smartRows.length ? smartRows : rows(devices)).map((d): NasDisk => ({
      id: str(d.devicefile) ?? '?', name: str(d.devicefile) ?? '?', model: [str(d.vendor), str(d.model)].filter(Boolean).join(' ') || undefined,
      serial: str(d.serialnumber), size: num(d.size) ?? 0, temperature: num(d.temperature), ...smartHealth(str(d.overallstatus)),
    }))
    data.shares = [
      ...rows(smb).map((s): NasShare => ({ id: `smb:${s.uuid}`, name: str(s.sharedfoldername) ?? str(s.name) ?? '?', protocol: 'SMB', enabled: s.enable !== false, comment: str(s.comment) })),
      ...rows(nfs).map((s): NasShare => ({ id: `nfs:${s.uuid}`, name: str(s.sharedfoldername) ?? '?', protocol: 'NFS', path: str(s.client), enabled: s.enable !== false, comment: str(s.comment) })),
    ]
    data.services = rows(services).map((s) => ({ id: str(s.name) ?? '?', name: str(s.title) ?? str(s.name) ?? '?', running: s.running === true, enabled: s.enabled === true, controllable: false }))
    data.tasks = [
      ...rows(rsync).map((t): NasTask => ({
        id: `rsync:${t.uuid}`, name: str(t.comment) || `${str(t.srcfoldername) ?? str(t.srcuri) ?? '?'} → ${str(t.destfoldername) ?? str(t.desturi) ?? '?'}`,
        type: 'rsync', detail: str(t.type) === 'remote' ? 'Rsync distant' : 'Rsync local', enabled: t.enable !== false, state: 'unknown', canRun: true,
      })),
      ...rows(cron).map((t): NasTask => ({
        id: `cron:${t.uuid}`, name: str(t.comment) || str(t.command) || 'Tâche planifiée', type: 'cron', detail: str(t.command), enabled: t.enable !== false, state: 'unknown', canRun: true,
      })),
    ]
    data.capabilities = ['reboot', 'shutdown', 'update']
    return data
  }

  async action(action: NasAction): Promise<string> {
    switch (action.kind) {
      case 'task': {
        const [type, uuid] = splitId(action.id)
        await this.rpc(type === 'cron' ? 'Cron' : 'Rsync', 'execute', { uuid })
        return 'Tâche lancée sur le NAS.'
      }
      case 'update':
        await this.rpc('Apt', 'upgrade')
        return 'Installation des mises à jour lancée sur le NAS.'
      case 'power':
        await this.rpc('System', action.op, { delay: 0 })
        return action.op === 'reboot' ? 'Redémarrage du NAS demandé.' : 'Arrêt du NAS demandé.'
      case 'service':
        throw new NasUnsupported('Le pilotage des services (configurez-les dans OpenMediaVault)')
      case 'app':
        throw new NasUnsupported('Le pilotage des applications')
      case 'scrub':
        throw new NasUnsupported('Le scrub')
    }
  }

  close(): void {
    if (this.cookie) void this.post('Session', 'logout', null).catch(() => undefined)
    this.cookie = null
    setTimeout(() => this.http.close(), 2000)
  }

  private async authenticate(): Promise<void> {
    this.cookie = null
    const res = await this.post('Session', 'login', { username: this.nas.username ?? '', password: this.secrets.secret })
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).filter(Boolean)
    const body = parseBody(res.body)
    if (body.error) throw new OmvError(num(body.error.code) ?? 0, cleanError(str(body.error.message)))
    if (obj(body.response).authenticated === false) throw new Error('Identifiant ou mot de passe incorrect.')
    if (!cookies.length) throw new Error('OpenMediaVault n’a pas ouvert de session.')
    this.cookie = cookies.join('; ')
  }

  private async rpc(service: string, method: string, params: unknown = null, retry = true): Promise<unknown> {
    if (!this.cookie) {
      this.login ??= this.authenticate().finally(() => (this.login = null))
      await this.login
    }
    const res = await this.post(service, method, params)
    const body = parseBody(res.body)
    if (body.error) {
      const code = num(body.error.code) ?? 0
      // 5000-5002 : session absente, expirée ou invalide.
      if (retry && (res.status === 401 || (code >= 5000 && code <= 5002) || /session/i.test(str(body.error.message) ?? ''))) {
        this.cookie = null
        return this.rpc(service, method, params, false)
      }
      throw new OmvError(code, cleanError(str(body.error.message)))
    }
    return body.response
  }

  private async post(service: string, method: string, params: unknown) {
    const res = await this.http.request('POST', '/rpc.php', {
      body: JSON.stringify({ service, method, params, options: null }),
      headers: { 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
    })
    if (res.status >= 500 || res.status === 404) throw new NasHttpError(res.status, httpErrorMessage(res))
    return res
  }
}

function parseBody(text: string): { response?: unknown; error?: Row } {
  try {
    const body = obj(JSON.parse(text))
    return { response: body.response, error: body.error ? obj(body.error) : undefined }
  } catch {
    throw new Error('Ce serveur ne répond pas comme OpenMediaVault (réponse RPC invalide).')
  }
}

const cleanError = (message: string | undefined) => {
  const text = (message ?? 'Erreur OpenMediaVault').split('\n')[0]
  return /incorrect username or password|authentication failed/i.test(text) ? 'Identifiant ou mot de passe incorrect.' : text
}

function smartHealth(status: string | undefined): Pick<NasDisk, 'health' | 'healthText'> {
  if (!status) return { health: 'unknown' }
  if (status === 'GOOD') return { health: 'ok', healthText: 'Bon' }
  if (status === 'BAD_STATUS' || status === 'BAD_SECTOR_MANY' || status === 'BAD_ATTRIBUTE_NOW') return { health: 'failing', healthText: status.replace(/_/g, ' ').toLowerCase() }
  return { health: 'warning', healthText: status.replace(/_/g, ' ').toLowerCase() }
}

/** Analyse d'un système de fichiers (exportée pour les tests). */
export function parseFilesystem(f: Row): NasPool {
  const total = num(f.size) ?? 0
  const available = num(f.available) ?? 0
  const status = num(f.status)
  return {
    id: str(f.uuid) ?? str(f.devicefile) ?? '?',
    name: str(f.label) || str(f.mountpoint) || str(f.devicefile) || '?',
    kind: 'filesystem',
    status: status === 1 ? 'healthy' : status === 3 ? 'faulted' : f.mounted === true ? 'healthy' : 'unknown',
    statusText: status === 3 ? 'Absent' : undefined,
    used: num(f.used) ?? Math.max(0, total - available),
    total,
    detail: [str(f.type), str(f.devicefile)].filter(Boolean).join(' · '),
    canScrub: false,
  }
}

function parseRaid(r: Row): NasPool {
  const state = str(r.state) ?? ''
  return {
    id: str(r.devicefile) ?? '?', name: str(r.name) || str(r.devicefile) || '?', kind: 'raid',
    status: /degraded|recovering|resyncing/i.test(state) ? 'degraded' : /fail|inactive/i.test(state) ? 'faulted' : state ? 'healthy' : 'unknown',
    statusText: state || undefined, used: 0, total: num(r.size) ?? 0,
    detail: `${str(r.level)?.toUpperCase() ?? 'RAID'} · ${num(r.numdevices) ?? arr(r.devices).length} disque(s)`, canScrub: false,
  }
}
