import type { NasAction, NasApp, NasDisk, NasPool, NasProfile, NasService, NasTask } from '@shared/types'
import { emptyData, NasOtpRequired, NasUnsupported, OP_LABEL, splitId, type NasData, type NasDriver, type NasSecrets } from './driver'
import { arr, form, HttpClient, num, obj, optional, str, time } from './http'

type Row = Record<string, unknown>
type ApiInfo = Record<string, { path: string; minVersion: number; maxVersion: number }>

const SESSION = 'BCenter'

class SynologyError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
  }
}

const AUTH_ERRORS: Record<number, string> = {
  400: 'Identifiant ou mot de passe incorrect.',
  401: 'Ce compte est désactivé.',
  402: 'Ce compte n’a pas l’autorisation de se connecter.',
  404: 'Code de validation en deux étapes incorrect.',
  406: 'La validation en deux étapes est obligatoire pour ce compte : activez-la dans DSM avant de connecter BCenter.',
  407: 'Adresse bloquée par la protection contre les connexions (trop de tentatives).',
  408: 'Mot de passe expiré : changez-le dans DSM.',
  410: 'Mot de passe à changer à la prochaine connexion : connectez-vous une fois à DSM.',
}

const COMMON_ERRORS: Record<number, string> = {
  101: 'Paramètre invalide.',
  102: 'API indisponible sur cette version de DSM.',
  103: 'Méthode indisponible sur cette version de DSM.',
  104: 'Version de l’API non prise en charge.',
  105: 'Permissions insuffisantes : utilisez un compte du groupe administrators.',
}

/** API Web de Synology DSM (DSM 6.2 et 7.x), session par identifiant « sid ». */
export class SynologyDriver implements NasDriver {
  private readonly http: HttpClient
  private apis: ApiInfo | null = null
  private sid: string | null = null
  private login: Promise<void> | null = null

  constructor(
    private readonly nas: NasProfile,
    private readonly secrets: NasSecrets,
  ) {
    this.http = new HttpClient(nas)
  }

  async test() {
    const deviceToken = await this.authenticate()
    const info = obj(await this.call('SYNO.Core.System', 'info', 1))
    return { version: str(info.firmware_ver) ?? 'DSM', deviceToken }
  }

  async snapshot(): Promise<NasData> {
    const call = (api: string, method: string, version: number, params: Row = {}) => optional(async () => obj(await this.call(api, method, version, params)), {} as Row)
    const info = obj(await this.call('SYNO.Core.System', 'info', 1))
    const [util, storage, shares, packages, containers, backups, smb, nfs, terminal, upgrade] = await Promise.all([
      call('SYNO.Core.System.Utilization', 'get', 1),
      call('SYNO.Storage.CGI.Storage', 'load_info', 1),
      call('SYNO.Core.Share', 'list', 1, { additional: JSON.stringify(['vol_path']), shareType: 'all' }),
      call('SYNO.Core.Package', 'list', 2, { additional: JSON.stringify(['status']) }),
      call('SYNO.Docker.Container', 'list', 1, { limit: -1, offset: 0, type: 'all' }),
      call('SYNO.Backup.Task', 'list', 1, { additional: JSON.stringify(['last_bkp_time', 'last_bkp_result']) }),
      call('SYNO.Core.FileServ.SMB', 'get', 3),
      call('SYNO.Core.FileServ.NFS', 'get', 2),
      call('SYNO.Core.Terminal', 'get', 3),
      call('SYNO.Core.Upgrade.Server', 'check', 1),
    ])

    const data = emptyData()
    const cpu = obj(util.cpu)
    const mem = obj(util.memory)
    const memTotal = (num(mem.memory_size) ?? num(mem.total_real) ?? 0) * 1024
    const update = Object.keys(obj(upgrade.update)).length ? obj(upgrade.update) : upgrade
    data.system = {
      hostname: str(info.hostname) ?? str(info.server_name),
      model: str(info.model),
      version: str(info.firmware_ver),
      uptime: parseUptime(str(info.up_time)),
      temperature: num(info.sys_temp),
      cpu: util.cpu ? ((num(cpu.user_load) ?? 0) + (num(cpu.system_load) ?? 0) + (num(cpu.other_load) ?? 0)) / 100 : undefined,
      memTotal: memTotal || (num(info.ram_size) ?? 0) * 1024 ** 2 || undefined,
      memUsed: num(mem.real_usage) != null && memTotal ? ((num(mem.real_usage) ?? 0) / 100) * memTotal : undefined,
      updates: update.available != null ? { available: update.available === true, version: str(update.version) } : undefined,
    }
    Object.assign(data, parseStorage(storage))
    data.shares = arr<Row>(shares.shares).map((s) => ({
      id: str(s.name) ?? '?', name: str(s.name) ?? '?', protocol: 'SMB / NFS', path: str(s.vol_path) ? `${s.vol_path}/${s.name}` : undefined, enabled: true, comment: str(s.desc),
    }))
    const services: NasService[] = []
    if (smb.enable_samba != null) services.push({ id: 'smb', name: 'SMB', running: smb.enable_samba === true, enabled: smb.enable_samba === true, controllable: false })
    if (nfs.enable_nfs != null) services.push({ id: 'nfs', name: 'NFS', running: nfs.enable_nfs === true, enabled: nfs.enable_nfs === true, controllable: false })
    if (terminal.enable_ssh != null) services.push({ id: 'ssh', name: 'SSH', running: terminal.enable_ssh === true, enabled: terminal.enable_ssh === true, controllable: false })
    data.services = services
    data.apps = [
      ...arr<Row>(containers.containers).map((c): NasApp => {
        const status = str(c.status) ?? (obj(c.State).Running ? 'running' : 'stopped')
        return { id: `docker:${c.name}`, name: str(c.name) ?? '?', kind: 'container', state: status === 'running' ? 'running' : status === 'stopped' || status === 'exited' ? 'stopped' : 'unknown', stateText: status, version: str(c.image), controllable: true }
      }),
      ...arr<Row>(packages.packages).map((p): NasApp => {
        const status = str(obj(p.additional).status)
        return { id: `pkg:${p.id}`, name: str(p.name) ?? str(p.id) ?? '?', kind: 'package', state: status === 'running' ? 'running' : status === 'stop' || status === 'stopped' ? 'stopped' : status === 'broken' ? 'error' : 'unknown', stateText: status, version: str(p.version), controllable: true }
      }),
    ]
    data.tasks = arr<Row>(backups.task_list).map((t): NasTask => {
      const result = str(t.last_bkp_result) ?? str(obj(t.additional).last_bkp_result)
      const status = str(t.status)
      return {
        id: `hb:${t.task_id}`, name: str(t.name) ?? `Hyper Backup ${t.task_id}`, type: 'backup', detail: 'Hyper Backup', enabled: true,
        lastRun: time(str(t.last_bkp_time) ?? obj(t.additional).last_bkp_time),
        state: status === 'backup' || status === 'waiting' ? 'running' : result === 'done' || result === 'success' ? 'ok' : result === 'failed' || result === 'partial' ? 'failed' : result === 'none' || !result ? 'never' : 'unknown',
        canRun: true,
      }
    })
    data.capabilities = ['reboot', 'shutdown']
    return data
  }

  async action(action: NasAction): Promise<string> {
    switch (action.kind) {
      case 'app': {
        const [type, id] = splitId(action.id)
        if (type === 'docker') {
          await this.call('SYNO.Docker.Container', action.op, 1, { name: JSON.stringify(id) })
        } else {
          if (action.op !== 'start') await this.call('SYNO.Core.Package.Control', 'stop', 1, { id })
          if (action.op !== 'stop') await this.call('SYNO.Core.Package.Control', 'start', 1, { id })
        }
        return `${OP_LABEL[action.op]} de ${id} demandé.`
      }
      case 'task': {
        const [, id] = splitId(action.id)
        await this.call('SYNO.Backup.Task', 'backup', 1, { task_id: Number(id) })
        return 'Sauvegarde Hyper Backup lancée.'
      }
      case 'power':
        await this.call('SYNO.Core.System', action.op, 1, { force: false, local: true })
        return action.op === 'reboot' ? 'Redémarrage du NAS demandé.' : 'Arrêt du NAS demandé.'
      case 'service':
        throw new NasUnsupported('Le pilotage des services de fichiers')
      case 'scrub':
        throw new NasUnsupported('Le nettoyage des données (scrubbing) depuis BCenter')
      case 'update':
        throw new NasUnsupported('L’installation des mises à jour DSM depuis BCenter')
    }
  }

  close(): void {
    if (this.sid && this.apis) {
      const info = this.apis['SYNO.API.Auth']
      if (info) void this.http.request('POST', `/webapi/${info.path}`, { body: form({ api: 'SYNO.API.Auth', version: Math.min(info.maxVersion, 6), method: 'logout', session: SESSION, _sid: this.sid }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => undefined)
    }
    this.sid = null
    setTimeout(() => this.http.close(), 2000)
  }

  private async resolve(api: string, preferred: number): Promise<{ path: string; version: number }> {
    if (!this.apis) {
      const res = await this.http.json<{ success: boolean; data?: ApiInfo }>('GET', '/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=all')
      if (!res.success || !res.data) throw new Error('Ce serveur ne répond pas comme un NAS Synology (API Web introuvable).')
      this.apis = res.data
    }
    const info = this.apis[api]
    if (!info) throw new SynologyError(102, COMMON_ERRORS[102])
    return { path: info.path, version: Math.max(info.minVersion, Math.min(info.maxVersion, preferred)) }
  }

  /** Ouvre une session ; renvoie le jeton d'appareil si un code de validation a été fourni. */
  private async authenticate(): Promise<string | undefined> {
    const { path, version } = await this.resolve('SYNO.API.Auth', 6)
    const otp = this.secrets.otp?.trim()
    const params = {
      api: 'SYNO.API.Auth', version, method: 'login', account: this.nas.username ?? '', passwd: this.secrets.secret,
      session: SESSION, format: 'sid',
      ...(otp ? { otp_code: otp, enable_device_token: 'yes', device_name: 'BCenter' } : this.secrets.deviceToken ? { device_id: this.secrets.deviceToken, device_name: 'BCenter' } : {}),
    }
    const res = await this.http.json<{ success: boolean; data?: Row; error?: { code: number } }>('POST', `/webapi/${path}`, {
      body: form(params), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (!res.success) {
      const code = res.error?.code ?? 0
      if (code === 403) throw new NasOtpRequired()
      throw new SynologyError(code, AUTH_ERRORS[code] ?? `Connexion refusée par DSM (code ${code}).`)
    }
    this.sid = str(res.data?.sid) ?? null
    if (!this.sid) throw new Error('DSM n’a pas renvoyé d’identifiant de session.')
    return str(res.data?.did) ?? str(res.data?.device_id)
  }

  private async call(api: string, method: string, preferred: number, params: Row = {}, retry = true): Promise<unknown> {
    if (!this.sid) {
      this.login ??= this.authenticate().then(() => undefined).finally(() => (this.login = null))
      await this.login
    }
    const { path, version } = await this.resolve(api, preferred)
    const body = form({ api, version, method, _sid: this.sid ?? '', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : (v as string)])) })
    const res = await this.http.json<{ success: boolean; data?: unknown; error?: { code: number } }>('POST', `/webapi/${path}`, {
      body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (res.success) return res.data ?? {}
    const code = res.error?.code ?? 0
    if (retry && [106, 107, 119].includes(code)) {
      this.sid = null
      return this.call(api, method, preferred, params, false)
    }
    throw new SynologyError(code, COMMON_ERRORS[code] ?? `Erreur DSM ${code} (${api}.${method}).`)
  }
}

/** « heures:minutes:secondes » (DSM) → secondes. */
export function parseUptime(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parts = value.split(':').map(Number)
  if (parts.some((n) => !Number.isFinite(n))) return undefined
  return parts.reduce((total, n) => total * 60 + n, 0)
}

const volumeHealth = (status: string | undefined): NasPool['status'] => {
  switch (status) {
    case 'normal': return 'healthy'
    case 'degrade': case 'degraded': case 'attention': case 'warning': case 'repairing': return 'degraded'
    case 'crashed': case 'fail': case 'failed': return 'faulted'
    default: return 'unknown'
  }
}

const diskHealth = (status: string | undefined, smart: string | undefined): Pick<NasDisk, 'health' | 'healthText'> => {
  const s = [status, smart].map((v) => v?.toLowerCase() ?? '')
  if (s.some((v) => ['crashed', 'failing', 'fail', 'damage', 'abnormal'].includes(v))) return { health: 'failing', healthText: smart ?? status }
  if (s.some((v) => ['warning', 'attention', 'degrade'].includes(v))) return { health: 'warning', healthText: smart ?? status }
  if (s.includes('normal') || s.includes('initialized')) return { health: 'ok', healthText: 'Normal' }
  return { health: 'unknown', healthText: status }
}

/** Analyse de SYNO.Storage.CGI.Storage load_info (exportée pour les tests). */
export function parseStorage(storage: Row): Pick<NasData, 'pools' | 'disks'> {
  const poolsById = new Map(arr<Row>(storage.storagePools).map((p) => [str(p.id) ?? '', p]))
  const pools = arr<Row>(storage.volumes).map((v): NasPool => {
    const size = obj(v.size)
    const pool = poolsById.get(str(v.pool_path) ?? '')
    const raid = str(pool?.device_type) ?? str(v.device_type) ?? str(v.raidType)
    const label = str(v.display_name) ?? str(v.vol_path)?.replace('/volume', 'Volume ') ?? str(v.id) ?? '?'
    return {
      id: str(v.id) ?? label, name: label, kind: 'volume', status: volumeHealth(str(v.status)), statusText: str(v.status),
      used: num(size.used) ?? 0, total: num(size.total) ?? 0,
      detail: [str(v.fs_type), raid?.replace(/_/g, ' ').toUpperCase()].filter(Boolean).join(' · ') || undefined,
      canScrub: false,
    }
  })
  const volumeOfPool = new Map(arr<Row>(storage.volumes).map((v, i) => [str(v.pool_path) ?? '', pools[i].name]))
  const disks = arr<Row>(storage.disks).map((d): NasDisk => ({
    id: str(d.id) ?? '?', name: str(d.longName) ?? str(d.name) ?? str(d.id) ?? '?', model: str(d.model)?.trim(), serial: str(d.serial),
    size: num(d.size_total) ?? 0, temperature: num(d.temp), pool: volumeOfPool.get(str(d.used_by) ?? '') ?? str(d.used_by),
    ...diskHealth(str(d.status), str(d.smart_status)),
  }))
  return { pools, disks }
}
