import type { NasAction, NasDisk, NasPool, NasProfile } from '@shared/types'
import { emptyData, NasUnsupported, type NasData, type NasDriver, type NasSecrets } from './driver'
import { form, HttpClient, httpErrorMessage, NasHttpError, num, optional } from './http'

/** Valeur d'une balise XML (avec ou sans CDATA) ; première occurrence. */
export function tag(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`).exec(xml)
  return match ? match[1].trim() : undefined
}

export function blocks(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1])
}

/**
 * CGI de QNAP QTS / QuTS hero (prise en charge de base : état du système, volumes, disques, alimentation).
 * Les applications Container Station et les tâches HBS 3 utilisent des API distinctes, non couvertes.
 */
export class QnapDriver implements NasDriver {
  private readonly http: HttpClient
  private sid: string | null = null
  private login: Promise<void> | null = null

  constructor(
    private readonly nas: NasProfile,
    private readonly secrets: NasSecrets,
  ) {
    this.http = new HttpClient(nas)
  }

  async test() {
    const xml = await this.cgi('/cgi-bin/management/manaRequest.cgi', { subfunc: 'sysinfo', hd: 'no', multicpu: 1 })
    return { version: `QTS ${tag(xml, 'version') ?? ''} ${tag(xml, 'build') ?? ''}`.trim() }
  }

  async snapshot(): Promise<NasData> {
    const sys = await this.cgi('/cgi-bin/management/manaRequest.cgi', { subfunc: 'sysinfo', hd: 'no', multicpu: 1 })
    const [volumes, disks] = await Promise.all([
      optional(() => this.cgi('/cgi-bin/management/chartReq.cgi', { chart_func: 'disk_usage', disk_select: 'all', include: 'all' }), ''),
      optional(() => this.cgi('/cgi-bin/disk/qsmart.cgi', { func: 'all_hd_data' }), ''),
    ])
    const data = emptyData()
    const memTotal = num(tag(sys, 'total_memory'))
    const memFree = num(tag(sys, 'free_memory'))
    const days = num(tag(sys, 'uptime_day')) ?? 0
    const hours = num(tag(sys, 'uptime_hour')) ?? 0
    const minutes = num(tag(sys, 'uptime_min')) ?? 0
    data.system = {
      hostname: tag(sys, 'serverName') ?? tag(sys, 'hostname'),
      model: tag(sys, 'displayModelName') ?? tag(sys, 'modelName'),
      version: tag(sys, 'version') ? `QTS ${tag(sys, 'version')} ${tag(sys, 'build') ?? ''}`.trim() : undefined,
      uptime: days * 86_400 + hours * 3600 + minutes * 60 || undefined,
      cpu: num(tag(sys, 'cpu_usage')?.replace('%', '')) != null ? (num(tag(sys, 'cpu_usage')?.replace('%', '')) ?? 0) / 100 : undefined,
      memTotal: memTotal ? memTotal * 1024 ** 2 : undefined,
      memUsed: memTotal && memFree != null ? (memTotal - memFree) * 1024 ** 2 : undefined,
      temperature: num(tag(sys, 'sys_tempc')) ?? num(tag(sys, 'cpu_tempc')),
    }
    data.pools = parseVolumes(volumes)
    data.disks = parseDisks(disks)
    data.capabilities = ['reboot', 'shutdown']
    return data
  }

  async action(action: NasAction): Promise<string> {
    if (action.kind !== 'power') throw new NasUnsupported('Cette action sur QNAP')
    await this.cgi('/cgi-bin/sys/sysRequest.cgi', { subfunc: 'power_mgmt', count: Date.now(), apply: action.op === 'reboot' ? 'restart' : 'shutdown' })
    return action.op === 'reboot' ? 'Redémarrage du NAS demandé.' : 'Arrêt du NAS demandé.'
  }

  close(): void {
    if (this.sid) void this.http.request('GET', `/cgi-bin/authLogout.cgi?${form({ sid: this.sid })}`).catch(() => undefined)
    this.sid = null
    setTimeout(() => this.http.close(), 2000)
  }

  private async authenticate(): Promise<void> {
    const res = await this.http.request('POST', '/cgi-bin/authLogin.cgi', {
      body: form({ user: this.nas.username ?? '', pwd: Buffer.from(this.secrets.secret, 'utf8').toString('base64'), serviceKey: 1, client_app: 'BCenter' }),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (res.status !== 200) throw new NasHttpError(res.status, httpErrorMessage(res))
    if (tag(res.body, 'need_2sv') === '1' || tag(res.body, 'need_2sv') === 'true') {
      throw new Error('Ce compte QNAP utilise la validation en deux étapes : créez un compte administrateur dédié à BCenter sans 2FA, ou restreignez-le au réseau local.')
    }
    const sid = tag(res.body, 'authSid')
    if (tag(res.body, 'authPassed') !== '1' || !sid) throw new Error('Identifiant ou mot de passe incorrect.')
    this.sid = sid
  }

  private async cgi(path: string, params: Record<string, string | number>, retry = true): Promise<string> {
    if (!this.sid) {
      this.login ??= this.authenticate().finally(() => (this.login = null))
      await this.login
    }
    const res = await this.http.request('GET', `${path}?${form({ ...params, sid: this.sid ?? '' })}`)
    if (res.status !== 200) throw new NasHttpError(res.status, httpErrorMessage(res))
    if (retry && tag(res.body, 'authPassed') === '0') {
      this.sid = null
      return this.cgi(path, params, false)
    }
    return res.body
  }
}

/** Analyse des volumes (chartReq.cgi disk_usage), exportée pour les tests. */
export function parseVolumes(xml: string): NasPool[] {
  const usage = new Map(blocks(xml, 'volumeUse').map((b) => [tag(b, 'volumeValue') ?? '', b]))
  return blocks(xml, 'volume').map((b): NasPool => {
    const id = tag(b, 'volumeValue') ?? tag(b, 'volumeLabel') ?? '?'
    const use = usage.get(id) ?? ''
    const total = num(tag(use, 'total_size')) ?? 0
    const free = num(tag(use, 'free_size')) ?? 0
    const status = tag(b, 'volumeStatus')
    return {
      id, name: tag(b, 'volumeLabel') ?? `Volume ${id}`, kind: 'volume',
      status: status == null ? 'unknown' : ['0', '1', 'ready', 'Ready'].includes(status) ? 'healthy' : /degrad/i.test(status) ? 'degraded' : 'unknown',
      statusText: status, used: Math.max(0, total - free), total, canScrub: false,
    }
  })
}

export function parseDisks(xml: string): NasDisk[] {
  return blocks(xml, 'entry')
    .filter((b) => tag(b, 'HD_Is_Exist') !== '0')
    .map((b): NasDisk => {
      const health = tag(b, 'Health') ?? ''
      const no = tag(b, 'HDNo') ?? '?'
      return {
        id: no, name: `Disque ${no}`, model: tag(b, 'Model'), serial: tag(b, 'Serial'), size: num(tag(b, 'Capacity_Bytes') ?? tag(b, 'Capacity')) ?? 0,
        temperature: num(tag(b, 'oC')),
        health: /^(ok|good|normal)$/i.test(health) ? 'ok' : /warn/i.test(health) ? 'warning' : /abnormal|bad|fail|error/i.test(health) ? 'failing' : 'unknown',
        healthText: health || undefined,
      }
    })
}
