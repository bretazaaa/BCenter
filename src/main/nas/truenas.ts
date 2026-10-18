import WebSocket from 'ws'
import type { NasAction, NasAlert, NasApp, NasDisk, NasPool, NasProfile, NasService, NasShare, NasTask } from '@shared/types'
import { emptyData, OP_LABEL, splitId, type NasData, type NasDriver, type NasSecrets } from './driver'
import { arr, HttpClient, num, obj, optional, str, stripHtml, time } from './http'

type Row = Record<string, unknown>

class RpcError extends Error {
  constructor(
    message: string,
    readonly notFound: boolean,
  ) {
    super(message)
  }
}

/**
 * Connexion à l'API TrueNAS par WebSocket : JSON-RPC 2.0 (/api/current, TrueNAS 25.04 et suivants)
 * ou protocole historique (/websocket, SCALE ≤ 24.10 et CORE). La connexion est conservée entre deux actualisations.
 */
class TrueNasSocket {
  private ws: WebSocket | null = null
  private legacy = false
  private ready: Promise<void> | null = null
  private nextId = 1
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
  ) {}

  async call<T = unknown>(method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
    this.ready ??= this.connect().catch((error) => {
      this.ready = null
      throw error
    })
    await this.ready
    return (await this.send(method, params, timeoutMs)) as T
  }

  /** Essaie plusieurs signatures (elles varient selon les versions de TrueNAS). */
  async callFirst<T = unknown>(variants: [string, unknown[]][]): Promise<T> {
    let last: unknown
    for (const [method, params] of variants) {
      try {
        return await this.call<T>(method, params)
      } catch (error) {
        last = error
        if (!(error instanceof RpcError)) throw error
      }
    }
    throw last
  }

  close(): void {
    this.ready = null
    this.ws?.removeAllListeners()
    this.ws?.terminate()
    this.ws = null
    this.failAll(new Error('Connexion fermée.'))
  }

  private async connect(): Promise<void> {
    try {
      await this.open('/api/current', false)
    } catch (error) {
      if (!(error instanceof HandshakeError)) throw error
      await this.open('/websocket', true)
    }
    const ok = await this.send('auth.login_with_api_key', [this.apiKey], 20_000).catch((error: Error) => {
      throw new Error(`Connexion refusée par TrueNAS : ${error.message}`)
    })
    if (ok !== true) {
      this.close()
      throw new Error('Clé API refusée par TrueNAS.')
    }
  }

  private open(path: string, legacy: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const scheme = this.http.nas.protocol === 'https' ? 'wss' : 'ws'
      const ws = new WebSocket(`${scheme}${this.http.origin.slice(this.http.nas.protocol.length)}${path}`, {
        agent: this.http.agent,
        handshakeTimeout: 15_000,
        headers: { 'User-Agent': 'BCenter' },
      })
      let settled = false
      ws.once('unexpected-response', (_req, res) => {
        settled = true
        ws.terminate()
        reject(res.statusCode === 404 || res.statusCode === 400 || res.statusCode === 405 ? new HandshakeError() : new Error(`Erreur HTTP ${res.statusCode}`))
      })
      ws.once('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      ws.once('open', () => {
        this.ws = ws
        this.legacy = legacy
        ws.on('message', (data) => this.onMessage(String(data), () => {
          if (!settled) {
            settled = true
            resolve()
          }
        }))
        ws.on('close', () => {
          if (this.ws === ws) {
            this.ws = null
            this.ready = null
          }
          this.failAll(new Error('Connexion au NAS interrompue.'))
          if (!settled) {
            settled = true
            reject(new Error('Connexion au NAS interrompue.'))
          }
        })
        if (legacy) ws.send(JSON.stringify({ msg: 'connect', version: '1', support: ['1'] }))
        else {
          settled = true
          resolve()
        }
      })
    })
  }

  private send(method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Connexion au NAS indisponible.'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Le NAS ne répond pas (délai dépassé).'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify(this.legacy ? { id, msg: 'method', method, params } : { jsonrpc: '2.0', id, method, params }))
    })
  }

  private onMessage(text: string, onConnected: () => void): void {
    let msg: Row
    try {
      msg = JSON.parse(text) as Row
    } catch {
      return
    }
    if (this.legacy) {
      if (msg.msg === 'connected') return onConnected()
      if (msg.msg === 'ping') return void this.ws?.send(JSON.stringify({ msg: 'pong', ...(msg.id ? { id: msg.id } : {}) }))
      if (msg.msg !== 'result') return
    }
    const id = msg.id == null ? null : String(msg.id)
    const entry = id ? this.pending.get(id) : undefined
    if (!entry || !id) return
    clearTimeout(entry.timer)
    this.pending.delete(id)
    if (msg.error) {
      const error = obj(msg.error)
      const data = obj(error.data)
      const reason = str(data.reason) ?? str(error.reason) ?? str(error.message) ?? str(error.error) ?? 'Erreur TrueNAS'
      const code = num(error.code)
      const notFound = code === -32601 || code === -32602 || /ENOMETHOD|not found|does not exist|Method .* not found|Invalid params|validation/i.test(`${error.errname ?? ''} ${reason}`)
      entry.reject(new RpcError(reason.split('\n')[0], notFound))
    } else {
      entry.resolve(msg.result)
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}

class HandshakeError extends Error {}

const SERVICE_NAMES: Record<string, string> = {
  cifs: 'SMB', nfs: 'NFS', ssh: 'SSH', ftp: 'FTP', iscsitarget: 'iSCSI', ups: 'UPS', snmp: 'SNMP', smartd: 'S.M.A.R.T.',
  lldp: 'LLDP', rsync: 'Rsync', webdav: 'WebDAV', openvpn_client: 'OpenVPN (client)', openvpn_server: 'OpenVPN (serveur)',
  dynamicdns: 'DNS dynamique', afp: 'AFP', s3: 'S3 (MinIO)', tftp: 'TFTP', nvmet: 'NVMe-oF', docker: 'Docker', incus: 'Incus',
}

export class TrueNasDriver implements NasDriver {
  private readonly http: HttpClient
  private readonly socket: TrueNasSocket

  constructor(nas: NasProfile, secrets: NasSecrets) {
    this.http = new HttpClient(nas)
    this.socket = new TrueNasSocket(this.http, secrets.secret)
  }

  async test() {
    const info = obj(await this.socket.call('system.info'))
    return { version: str(info.version) ?? 'TrueNAS' }
  }

  async snapshot(): Promise<NasData> {
    const c = this.socket
    const list = (method: string, params: unknown[] = []) => optional(async () => arr<Row>(await c.call(method, params)), [] as Row[])
    const info = obj(await c.call('system.info'))
    const [pools, disks, temps, smb, nfs, services, apps, charts, vms, jails, snapTasks, replications, cloud, rsync, alerts, update] = await Promise.all([
      list('pool.query'), list('disk.query'), optional(async () => obj(await c.call('disk.temperatures', [[]])), {} as Row),
      list('sharing.smb.query'), list('sharing.nfs.query'), list('service.query'),
      list('app.query'), list('chart.release.query'), list('vm.query'), list('jail.query'),
      list('pool.snapshottask.query'), list('replication.query'), list('cloudsync.query'), list('rsynctask.query'),
      list('alert.list'), optional(async () => obj(await c.call('update.check_available', [], 60_000)), {} as Row),
    ])

    const data = emptyData()
    data.system = {
      hostname: str(info.hostname),
      model: str(info.system_product) ?? str(info.model),
      version: str(info.version),
      uptime: num(info.uptime_seconds),
      memTotal: num(info.physmem),
      updates: str(update.status) === 'AVAILABLE' ? { available: true, version: str(update.version) } : update.status ? { available: false } : undefined,
    }
    const diskStatus = new Map<string, { status: string; errors: number; pool: string }>()
    data.pools = pools.map((p) => parsePool(p, diskStatus))
    data.disks = disks.map((d): NasDisk => {
      const name = str(d.name) ?? str(d.devname) ?? '?'
      const st = diskStatus.get(name)
      return {
        id: str(d.identifier) ?? name,
        name,
        model: str(d.model),
        serial: str(d.serial),
        size: num(d.size) ?? 0,
        temperature: num(temps[name]),
        pool: st?.pool,
        ...diskHealth(st),
      }
    })
    data.shares = [
      ...smb.map((s): NasShare => ({ id: `smb:${s.id}`, name: str(s.name) ?? '?', protocol: 'SMB', path: str(s.path), enabled: s.enabled !== false, comment: str(s.comment) })),
      ...nfs.map((s): NasShare => {
        const path = str(s.path) ?? arr<string>(s.paths).join(', ')
        return { id: `nfs:${s.id}`, name: path.split('/').pop() || path, protocol: 'NFS', path, enabled: s.enabled !== false, comment: str(s.comment) }
      }),
    ]
    data.services = services.map((s): NasService => {
      const id = str(s.service) ?? '?'
      return { id, name: SERVICE_NAMES[id] ?? id, running: s.state === 'RUNNING', enabled: s.enable === true, controllable: true }
    })
    data.apps = [
      ...apps.map((a): NasApp => ({
        id: `app:${a.name ?? a.id}`, name: str(a.name) ?? '?', kind: 'app', state: appState(str(a.state)), stateText: str(a.state),
        version: str(a.human_version) ?? str(a.version), updateAvailable: a.upgrade_available === true, controllable: true,
      })),
      ...(apps.length ? [] : charts).map((a): NasApp => ({
        id: `chart:${a.name ?? a.id}`, name: str(a.name) ?? '?', kind: 'app', state: appState(str(a.status)), stateText: str(a.status),
        version: str(a.human_version), updateAvailable: a.update_available === true, controllable: true,
      })),
      ...vms.map((v): NasApp => {
        const state = str(obj(v.status).state)
        return { id: `vm:${v.id}`, name: str(v.name) ?? `VM ${v.id}`, kind: 'vm', state: appState(state), stateText: state, controllable: true }
      }),
      ...jails.map((j): NasApp => ({
        id: `jail:${j.id}`, name: str(j.id) ?? '?', kind: 'jail', state: j.state === 'up' ? 'running' : 'stopped', stateText: str(j.state), version: str(j.release), controllable: true,
      })),
    ]
    data.tasks = [
      ...snapTasks.map((t): NasTask => {
        const st = obj(t.state)
        return { id: `snap:${t.id}`, name: `Snapshots ${str(t.dataset) ?? ''}`.trim(), type: 'snapshot', detail: str(t.naming_schema), enabled: t.enabled !== false, lastRun: time(st.datetime), state: taskState(str(st.state)), canRun: true }
      }),
      ...replications.map((t): NasTask => {
        const st = obj(t.state)
        return { id: `repl:${t.id}`, name: str(t.name) ?? `Réplication ${t.id}`, type: 'replication', enabled: t.enabled !== false, lastRun: time(st.datetime), state: taskState(str(st.state)), canRun: true }
      }),
      ...cloud.map((t): NasTask => {
        const job = obj(t.job)
        return { id: `cloud:${t.id}`, name: str(t.description) ?? `Cloud Sync ${t.id}`, type: 'cloudsync', detail: str(t.path), enabled: t.enabled !== false, lastRun: time(job.time_finished) ?? time(job.time_started), state: taskState(str(job.state)), canRun: true }
      }),
      ...rsync.map((t): NasTask => {
        const job = obj(t.job)
        return { id: `rsync:${t.id}`, name: str(t.desc) ?? str(t.path) ?? `Rsync ${t.id}`, type: 'rsync', detail: [str(t.remotehost), str(t.remotemodule) ?? str(t.remotepath)].filter(Boolean).join(' · ') || undefined, enabled: t.enabled !== false, lastRun: time(job.time_finished), state: taskState(str(job.state)), canRun: true }
      }),
    ]
    data.alerts = alerts.filter((a) => a.dismissed !== true).map((a): NasAlert => ({
      id: str(a.uuid) ?? str(a.id) ?? String(Math.random()),
      level: alertLevel(str(a.level)),
      message: stripHtml(str(a.formatted) ?? str(a.text) ?? str(a.klass) ?? 'Alerte TrueNAS'),
      time: time(a.datetime),
    }))
    data.capabilities = ['reboot', 'shutdown', 'update']
    return data
  }

  async action(action: NasAction): Promise<string> {
    const c = this.socket
    switch (action.kind) {
      case 'service':
        await c.callFirst([['service.control', [action.op.toUpperCase(), action.id]], [`service.${action.op}`, [action.id]]])
        return `${OP_LABEL[action.op]} du service ${SERVICE_NAMES[action.id] ?? action.id} demandé.`
      case 'app': {
        const [type, id] = splitId(action.id)
        const numericId = Number(id)
        if (type === 'app') {
          await c.call(action.op === 'restart' ? 'app.redeploy' : `app.${action.op}`, [id])
        } else if (type === 'chart') {
          // Anciennes applications (Kubernetes) : démarrage et arrêt par le nombre de réplicas.
          for (const replicas of action.op === 'stop' ? [0] : action.op === 'start' ? [1] : [0, 1]) {
            await c.call('chart.release.scale', [id, { replica_count: replicas }])
          }
        } else if (type === 'vm') {
          await c.callFirst(action.op === 'stop' ? [['vm.stop', [numericId, { force: false }]], ['vm.stop', [numericId]]] : [[`vm.${action.op}`, [numericId]]])
        } else {
          await c.call(`jail.${action.op}`, [id])
        }
        return `${OP_LABEL[action.op]} de ${id} demandé.`
      }
      case 'task': {
        const [type, raw] = splitId(action.id)
        const id = Number(raw)
        const method = { snap: 'pool.snapshottask.run', repl: 'replication.run', cloud: 'cloudsync.sync', rsync: 'rsynctask.run' }[type]
        if (!method) throw new Error('Tâche inconnue.')
        await c.call(method, [id])
        return 'Tâche lancée sur le NAS.'
      }
      case 'scrub':
        await c.callFirst([['pool.scrub.scrub', [action.poolId, 'START']], ['pool.scrub.run', [action.poolId, 0]]])
        return `Scrub du pool ${action.poolId} lancé.`
      case 'update':
        await c.callFirst([['update.run', [{ reboot: true }]], ['update.update', [{ reboot: true }]]])
        return 'Mise à jour lancée : le NAS redémarrera à la fin de l’installation.'
      case 'power': {
        const method = `system.${action.op}`
        await c.callFirst([[method, ['Demandé depuis BCenter']], [method, [{}]], [method, []]])
        return action.op === 'reboot' ? 'Redémarrage du NAS demandé.' : 'Arrêt du NAS demandé.'
      }
    }
  }

  close(): void {
    this.socket.close()
    this.http.close()
  }
}

// ------------------------------------------------------------------ Analyse (exportée pour les tests)

export function parsePool(p: Row, disks: Map<string, { status: string; errors: number; pool: string }>): NasPool {
  const name = str(p.name) ?? '?'
  const walk = (node: Row) => {
    const children = arr<Row>(node.children)
    if (str(node.type) === 'DISK' || (children.length === 0 && node.disk)) {
      const stats = obj(node.stats)
      const errors = (num(stats.read_errors) ?? 0) + (num(stats.write_errors) ?? 0) + (num(stats.checksum_errors) ?? 0)
      const disk = str(node.disk) ?? str(node.device)?.replace(/p?\d+$/, '')
      if (disk) disks.set(disk, { status: str(node.status) ?? 'UNKNOWN', errors, pool: name })
    }
    children.forEach(walk)
  }
  for (const group of Object.values(obj(p.topology))) arr<Row>(group).forEach(walk)

  const status = str(p.status) ?? 'UNKNOWN'
  const scan = obj(p.scan)
  const isScrub = str(scan.function) === 'SCRUB'
  const vdev = arr<Row>(obj(p.topology).data)[0]
  return {
    id: name,
    name,
    kind: 'pool',
    status: status === 'ONLINE' ? (p.healthy === false ? 'degraded' : 'healthy') : status === 'DEGRADED' ? 'degraded' : status === 'OFFLINE' ? 'offline' : ['FAULTED', 'UNAVAIL', 'REMOVED', 'SUSPENDED'].includes(status) ? 'faulted' : 'unknown',
    statusText: status,
    used: num(p.allocated) ?? 0,
    total: num(p.size) ?? 0,
    detail: vdev ? `ZFS · ${str(vdev.type) ?? ''}`.trim() : 'ZFS',
    scrub: isScrub ? { running: str(scan.state) === 'SCANNING', lastRun: time(scan.end_time) ?? time(scan.start_time), errors: num(scan.errors) } : undefined,
    canScrub: status === 'ONLINE' || status === 'DEGRADED',
  }
}

function diskHealth(st: { status: string; errors: number } | undefined): Pick<NasDisk, 'health' | 'healthText'> {
  if (!st) return { health: 'unknown', healthText: 'Hors pool' }
  if (['FAULTED', 'UNAVAIL', 'REMOVED'].includes(st.status)) return { health: 'failing', healthText: st.status }
  if (st.status !== 'ONLINE') return { health: 'warning', healthText: st.status }
  if (st.errors > 0) return { health: 'warning', healthText: `${st.errors} erreur(s) E/S` }
  return { health: 'ok', healthText: 'En ligne' }
}

function appState(state: string | undefined): NasApp['state'] {
  switch (state?.toUpperCase()) {
    case 'RUNNING': case 'ACTIVE': case 'UP': return 'running'
    case 'STOPPED': case 'SHUTOFF': case 'DOWN': case 'EXITED': return 'stopped'
    case 'CRASHED': case 'ERROR': return 'error'
    case 'DEPLOYING': case 'STARTING': case 'STOPPING': return 'busy'
    default: return 'unknown'
  }
}

function taskState(state: string | undefined): NasTask['state'] {
  switch (state?.toUpperCase()) {
    case 'FINISHED': case 'SUCCESS': return 'ok'
    case 'ERROR': case 'FAILED': case 'ABORTED': return 'failed'
    case 'RUNNING': case 'WAITING': return 'running'
    case 'PENDING': case undefined: return 'never'
    default: return 'unknown'
  }
}

function alertLevel(level: string | undefined): NasAlert['level'] {
  switch (level) {
    case 'WARNING': return 'warning'
    case 'ERROR': case 'CRITICAL': case 'ALERT': case 'EMERGENCY': return 'critical'
    default: return 'info'
  }
}
