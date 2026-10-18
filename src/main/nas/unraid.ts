import type { NasAction, NasAlert, NasApp, NasDisk, NasPool, NasProfile } from '@shared/types'
import { emptyData, NasUnsupported, OP_LABEL, splitId, type NasData, type NasDriver, type NasSecrets } from './driver'
import { arr, HttpClient, num, obj, optional, str, time } from './http'

type Row = Record<string, unknown>

/**
 * API GraphQL d'Unraid (Unraid 7 ; intégrée à partir de 7.2, plugin « Unraid Connect » auparavant).
 * Le schéma évolue d'une version à l'autre : chaque section est lue séparément et ses variantes essayées dans l'ordre.
 */
export class UnraidDriver implements NasDriver {
  private readonly http: HttpClient

  constructor(
    nas: NasProfile,
    private readonly secrets: NasSecrets,
  ) {
    this.http = new HttpClient(nas)
  }

  async test() {
    const vars = obj(obj(await this.query('{ vars { version name } }')).vars)
    return { version: `Unraid ${str(vars.version) ?? ''}`.trim() }
  }

  async snapshot(): Promise<NasData> {
    const first = (queries: string[]) => optional(() => this.queryFirst(queries), {} as Row)
    const [vars, info, metrics, array, shares, docker, vms, notifications] = await Promise.all([
      this.query('{ vars { version name } }').then(obj),
      first(['{ info { os { hostname uptime } system { manufacturer model } } }', '{ info { os { hostname uptime } } }']),
      first(['{ metrics { cpu { percentTotal } memory { total used } } }']),
      first([
        '{ array { state disks { id name device size temp status fsSize fsUsed type } parities { id name device size temp status } caches { id name device size temp status fsSize fsUsed } } }',
        '{ array { state disks { id name device size temp status } parities { id name device size temp status } caches { id name device size temp status } } }',
      ]),
      first(['{ shares { name comment free used size } }', '{ shares { name comment } }']),
      first(['{ docker { containers { id names state status image } } }']),
      first(['{ vms { domains { id name state } } }', '{ vms { domains { uuid name state } } }', '{ vms { domain { uuid name state } } }']),
      first(['{ notifications { list(filter: { type: UNREAD, offset: 0, limit: 50 }) { id title subject description importance timestamp } } }']),
    ])

    const data = emptyData()
    const v = obj(vars.vars)
    const os = obj(obj(info.info).os)
    const sys = obj(obj(info.info).system)
    const m = obj(metrics.metrics)
    const boot = time(os.uptime)
    data.system = {
      hostname: str(v.name) ?? str(os.hostname),
      model: [str(sys.manufacturer), str(sys.model)].filter(Boolean).join(' ') || undefined,
      version: str(v.version) ? `Unraid ${v.version}` : undefined,
      uptime: boot ? Math.max(0, (Date.now() - boot) / 1000) : undefined,
      cpu: num(obj(m.cpu).percentTotal) != null ? (num(obj(m.cpu).percentTotal) ?? 0) / 100 : undefined,
      memTotal: num(obj(m.memory).total),
      memUsed: num(obj(m.memory).used),
    }
    Object.assign(data, parseArray(obj(array.array)))
    data.shares = arr<Row>(shares.shares).map((s) => ({ id: str(s.name) ?? '?', name: str(s.name) ?? '?', protocol: 'SMB', path: `/mnt/user/${s.name}`, enabled: true, comment: str(s.comment) }))
    data.apps = [
      ...arr<Row>(obj(docker.docker).containers).map((c): NasApp => {
        const state = str(c.state)?.toUpperCase()
        const name = (arr<string>(c.names)[0] ?? str(c.id) ?? '?').replace(/^\//, '')
        return { id: `docker:${c.id}`, name, kind: 'container', state: state === 'RUNNING' ? 'running' : state === 'EXITED' || state === 'PAUSED' ? 'stopped' : 'unknown', stateText: str(c.status) ?? state, version: str(c.image), controllable: true }
      }),
      ...arr<Row>(obj(vms.vms).domains ?? obj(vms.vms).domain).map((d): NasApp => {
        const state = str(d.state)?.toUpperCase()
        return { id: `vm:${d.id ?? d.uuid}`, name: str(d.name) ?? '?', kind: 'vm', state: state === 'RUNNING' ? 'running' : state === 'SHUTOFF' || state === 'SHUTDOWN' || state === 'PAUSED' ? 'stopped' : state === 'CRASHED' ? 'error' : 'unknown', stateText: state, controllable: true }
      }),
    ]
    data.tasks = [{ id: 'parity:check', name: 'Contrôle de parité', type: 'parity', detail: 'Vérification sans correction', enabled: true, state: 'unknown', canRun: true }]
    data.alerts = arr<Row>(obj(notifications.notifications).list).map((n): NasAlert => {
      const importance = str(n.importance)?.toUpperCase()
      return {
        id: str(n.id) ?? String(Math.random()),
        level: importance === 'ALERT' ? 'critical' : importance === 'WARNING' ? 'warning' : 'info',
        message: [str(n.subject) ?? str(n.title), str(n.description)].filter(Boolean).join(' — '),
        time: time(n.timestamp),
      }
    })
    return data
  }

  async action(action: NasAction): Promise<string> {
    switch (action.kind) {
      case 'app': {
        const [type, id] = splitId(action.id)
        const literal = JSON.stringify(id)
        if (type === 'docker') {
          if (action.op !== 'start') await this.query(`mutation { docker { stop(id: ${literal}) { id } } }`)
          if (action.op !== 'stop') await this.query(`mutation { docker { start(id: ${literal}) { id } } }`)
        } else {
          await this.query(`mutation { vm { ${action.op === 'restart' ? 'reboot' : action.op}(id: ${literal}) } }`)
        }
        return `${OP_LABEL[action.op]} demandé.`
      }
      case 'task':
        await this.queryFirst(['mutation { parityCheck { start(correct: false) } }', 'mutation { startParityCheck(correct: false) }'])
        return 'Contrôle de parité lancé.'
      case 'service':
        throw new NasUnsupported('Le pilotage des services')
      case 'scrub':
        throw new NasUnsupported('Le scrub')
      case 'update':
        throw new NasUnsupported('L’installation des mises à jour d’Unraid depuis BCenter')
      case 'power':
        throw new NasUnsupported('Le redémarrage par l’API (utilisez le shell SSH)')
    }
  }

  close(): void {
    this.http.close()
  }

  private async queryFirst(queries: string[]): Promise<Row> {
    let last: unknown
    for (const q of queries) {
      try {
        return obj(await this.query(q))
      } catch (error) {
        last = error
      }
    }
    throw last
  }

  private async query(query: string): Promise<unknown> {
    const res = await this.http.json<{ data?: unknown; errors?: { message?: string }[] }>('POST', '/graphql', {
      body: JSON.stringify({ query }),
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.secrets.secret },
    })
    if (res.errors?.length && !res.data) throw new Error(res.errors[0].message ?? 'Erreur GraphQL Unraid')
    if (res.errors?.length) {
      const message = res.errors[0].message ?? ''
      if (/forbidden|unauthori[sz]ed|permission/i.test(message)) throw new Error(`Permissions insuffisantes pour la clé API : ${message}`)
      if (/Cannot query field|Unknown argument|Unknown type/i.test(message)) throw new Error(message)
    }
    return res.data ?? {}
  }
}

const diskHealth = (status: string | undefined): Pick<NasDisk, 'health' | 'healthText'> => {
  if (!status) return { health: 'unknown' }
  if (status === 'DISK_OK') return { health: 'ok', healthText: 'Normal' }
  if (['DISK_DSBL', 'DISK_NP_DSBL', 'DISK_INVALID', 'DISK_WRONG', 'DISK_NP_MISSING'].includes(status)) return { health: 'failing', healthText: status.replace('DISK_', '') }
  return { health: 'warning', healthText: status.replace('DISK_', '') }
}

/** Analyse de la grappe Unraid (exportée pour les tests). Tailles de l'API en kilo-octets. */
export function parseArray(array: Row): Pick<NasData, 'pools' | 'disks'> {
  const KB = 1024
  const toDisk = (d: Row, pool: string): NasDisk => ({
    id: str(d.id) ?? str(d.name) ?? '?', name: str(d.name) ?? '?', model: str(d.device), size: (num(d.size) ?? 0) * KB,
    temperature: num(d.temp), pool, ...diskHealth(str(d.status)),
  })
  const present = (d: Row) => str(d.status) !== 'DISK_NP'
  const data = arr<Row>(array.disks).filter(present)
  const parities = arr<Row>(array.parities).filter(present)
  const caches = arr<Row>(array.caches).filter(present)
  const disks = [...parities.map((d) => toDisk(d, 'Parité')), ...data.map((d) => toDisk(d, 'Grappe')), ...caches.map((d) => toDisk(d, 'Cache'))]

  const state = str(array.state)
  const issues = disks.filter((d) => d.pool !== 'Cache')
  const health: NasPool['status'] = !state ? 'unknown' : state !== 'STARTED' ? 'offline'
    : issues.some((d) => d.health !== 'ok' && d.health !== 'unknown') ? 'degraded' : 'healthy'
  const sum = (rows: Row[], key: string) => rows.reduce((s, d) => s + (num(d[key]) ?? 0), 0) * KB
  const pools: NasPool[] = []
  if (state || data.length) {
    pools.push({ id: 'array', name: 'Grappe', kind: 'array', status: health, statusText: state, used: sum(data, 'fsUsed'), total: sum(data, 'fsSize'), detail: `${data.length} disque(s) · ${parities.length} parité(s)`, canScrub: false })
  }
  if (caches.length) {
    pools.push({ id: 'cache', name: 'Cache', kind: 'cache', status: caches.some((d) => diskHealth(str(d.status)).health === 'failing') ? 'degraded' : state === 'STARTED' ? 'healthy' : 'offline', used: sum(caches, 'fsUsed'), total: sum(caches, 'fsSize'), detail: `${caches.length} disque(s)`, canScrub: false })
  }
  return { pools, disks }
}

