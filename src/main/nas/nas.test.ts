import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { NasAction, NasProfile, NasSnapshot, ServerProfile } from '@shared/types'
import { secretKeys, type SecretCipher } from '../data/secrets'
import { Engine } from '../engine'
import { AlertEngine } from '../services/alerts'
import { emptyData, NasOtpRequired, type NasDriver, type NasSecrets } from './driver'
import { parseFilesystem } from './omv'
import { parseDisks, parseVolumes } from './qnap'
import { parseStorage, parseUptime } from './synology'
import { parsePool, TrueNasDriver } from './truenas'
import { parseArray } from './unraid'

describe('analyse des réponses NAS', () => {
  it('TrueNAS : pool, scrub et santé des disques depuis la topologie', () => {
    const disks = new Map()
    const pool = parsePool({
      name: 'tank', status: 'DEGRADED', healthy: false, size: 1000, allocated: 400,
      scan: { function: 'SCRUB', state: 'FINISHED', end_time: { $date: 1_700_000_000_000 }, errors: 0 },
      topology: { data: [{ type: 'RAIDZ2', children: [
        { type: 'DISK', disk: 'sda', status: 'ONLINE', stats: { read_errors: 0, write_errors: 0, checksum_errors: 0 } },
        { type: 'DISK', disk: 'sdb', status: 'FAULTED', stats: {} },
      ] }], cache: [] },
    }, disks)
    expect(pool).toMatchObject({ id: 'tank', status: 'degraded', used: 400, total: 1000, detail: 'ZFS · RAIDZ2', canScrub: true })
    expect(pool.scrub).toEqual({ running: false, lastRun: 1_700_000_000_000, errors: 0 })
    expect(disks.get('sdb')).toMatchObject({ status: 'FAULTED', pool: 'tank' })
  })

  it('Synology : volumes, disques et durée de fonctionnement', () => {
    const { pools, disks } = parseStorage({
      volumes: [{ id: 'volume_1', vol_path: '/volume1', status: 'degraded', fs_type: 'btrfs', pool_path: 'reuse_1', size: { total: '4000', used: '1000' } }],
      storagePools: [{ id: 'reuse_1', device_type: 'shr_with_1_disk_protect' }],
      disks: [{ id: 'sata1', longName: 'Disque 1', model: 'ST4000 ', size_total: '4000', temp: 38, status: 'normal', smart_status: 'warning', used_by: 'reuse_1' }],
    })
    expect(pools[0]).toMatchObject({ name: 'Volume 1', status: 'degraded', used: 1000, total: 4000, detail: 'btrfs · SHR WITH 1 DISK PROTECT' })
    expect(disks[0]).toMatchObject({ name: 'Disque 1', model: 'ST4000', health: 'warning', pool: 'Volume 1', temperature: 38 })
    expect(parseUptime('49:10:5')).toBe(49 * 3600 + 10 * 60 + 5)
  })

  it('Unraid : grappe, parité, cache (tailles en Kio)', () => {
    const { pools, disks } = parseArray({
      state: 'STARTED',
      parities: [{ id: 'p', name: 'parity', size: 10, status: 'DISK_OK' }],
      disks: [
        { id: 'd1', name: 'disk1', size: 10, fsSize: 10, fsUsed: 4, status: 'DISK_OK', temp: 33 },
        { id: 'd2', name: 'disk2', size: 10, fsSize: 10, fsUsed: 1, status: 'DISK_DSBL' },
        { id: 'd3', name: 'disk3', status: 'DISK_NP' },
      ],
      caches: [{ id: 'c', name: 'cache', size: 5, fsSize: 5, fsUsed: 2, status: 'DISK_OK' }],
    })
    expect(pools.map((p) => [p.id, p.status, p.used, p.total])).toEqual([['array', 'degraded', 5 * 1024, 20 * 1024], ['cache', 'healthy', 2 * 1024, 5 * 1024]])
    expect(disks.map((d) => [d.name, d.health])).toEqual([['parity', 'ok'], ['disk1', 'ok'], ['disk2', 'failing'], ['cache', 'ok']])
  })

  it('OpenMediaVault et QNAP', () => {
    expect(parseFilesystem({ uuid: 'u', label: 'data', type: 'ext4', size: '1000', available: '250', status: 1, mounted: true })).toMatchObject({ name: 'data', used: 750, total: 1000, status: 'healthy' })
    const volumes = parseVolumes(`<QDocRoot><volumeList><volume><volumeValue>1</volumeValue><volumeLabel><![CDATA[DataVol1]]></volumeLabel><volumeStatus>0</volumeStatus></volume></volumeList>
      <volumeUseList><volumeUse><volumeValue>1</volumeValue><total_size>1000</total_size><free_size>400</free_size></volumeUse></volumeUseList></QDocRoot>`)
    expect(volumes).toMatchObject([{ name: 'DataVol1', used: 600, total: 1000, status: 'healthy' }])
    const disks = parseDisks('<Disk_Info><entry><HDNo>1</HDNo><Model><![CDATA[WD40EFRX]]></Model><Health>Warning</Health><HD_Is_Exist>1</HD_Is_Exist><Temperature><oC>41</oC></Temperature></entry><entry><HDNo>2</HDNo><HD_Is_Exist>0</HD_Is_Exist></entry></Disk_Info>')
    expect(disks).toMatchObject([{ name: 'Disque 1', model: 'WD40EFRX', health: 'warning', temperature: 41 }])
  })
})

describe('TrueNAS par WebSocket', () => {
  const servers: WebSocketServer[] = []
  afterEach(() => servers.splice(0).forEach((s) => s.close()))

  /** Serveur factice : JSON-RPC 2.0 (/api/current) ou protocole historique (/websocket). */
  const serve = (legacy: boolean) =>
    new Promise<number>((resolve) => {
      const wss: WebSocketServer = new WebSocketServer({ port: 0, host: '127.0.0.1', path: legacy ? '/websocket' : '/api/current' }, (): void => resolve((wss.address() as AddressInfo).port))
      servers.push(wss)
      wss.on('connection', (ws: WebSocket) => {
        let authed = false
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(String(raw)) as { id?: string; msg?: string; method?: string; params?: unknown[] }
          if (legacy && msg.msg === 'connect') return ws.send(JSON.stringify({ msg: 'connected', session: 'x' }))
          const reply = (body: object) => ws.send(JSON.stringify(legacy ? { msg: 'result', id: msg.id, ...body } : { jsonrpc: '2.0', id: msg.id, ...body }))
          if (msg.method === 'auth.login_with_api_key') {
            authed = msg.params?.[0] === 'good-key'
            return reply({ result: authed })
          }
          if (!authed) return reply({ error: { code: -32001, message: 'Not authenticated' } })
          if (msg.method === 'system.info') return reply({ result: { version: legacy ? 'TrueNAS-13.0-U6' : 'TrueNAS-25.04.2', hostname: 'nas', physmem: 64, uptime_seconds: 100 } })
          if (msg.method === 'pool.query') return reply({ result: [{ name: 'tank', status: 'ONLINE', healthy: true, size: 10, allocated: 5, topology: {} }] })
          return reply({ error: legacy ? { error: 22, errname: 'ENOMETHOD', reason: 'Method does not exist' } : { code: -32601, message: 'Method not found' } })
        })
      })
    })

  const profile = (port: number): NasProfile => ({ id: 'n', name: 'nas', kind: 'truenas', host: '127.0.0.1', port, protocol: 'http', username: null, pinnedFingerprint: null, sshTargetId: null, createdAt: '' })

  for (const legacy of [false, true]) {
    it(`${legacy ? 'protocole historique' : 'JSON-RPC 2.0'} : connexion, lecture tolérante et refus de clé`, async () => {
      const port = await serve(legacy)
      const driver = new TrueNasDriver(profile(port), { secret: 'good-key' })
      try {
        expect((await driver.test()).version).toBe(legacy ? 'TrueNAS-13.0-U6' : 'TrueNAS-25.04.2')
        const data = await driver.snapshot()
        expect(data.pools.map((p) => p.name)).toEqual(['tank'])
        expect(data.apps).toEqual([])
      } finally {
        driver.close()
      }
      const bad = new TrueNasDriver(profile(port), { secret: 'bad-key' })
      await expect(bad.test()).rejects.toThrow(/Clé API refusée/)
      bad.close()
    })
  }
})

describe('NAS dans le moteur', () => {
  const cipher: SecretCipher = {
    isAvailable: () => true,
    encrypt: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a) as Buffer,
    decrypt: (d) => Buffer.from(d.map((b) => b ^ 0x5a)).toString('utf8'),
  }
  let dir: string
  let engine: Engine
  afterEach(() => {
    engine.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  it('secret chiffré, jeton d’appareil après validation en deux étapes, action transmise au pilote', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bcenter-nas-'))
    const actions: NasAction[] = []
    const seen: NasSecrets[] = []
    const factory = (_nas: NasProfile, secrets: NasSecrets): NasDriver => {
      seen.push(secrets)
      return {
        test: async () => {
          if (!secrets.otp && !secrets.deviceToken) throw new NasOtpRequired()
          return { version: 'DSM 7.2', deviceToken: secrets.otp ? 'device-123' : undefined }
        },
        snapshot: async () => emptyData(),
        action: async (a) => {
          actions.push(a)
          return 'ok'
        },
        close: () => undefined,
      }
    }
    engine = new Engine({ dataDir: dir, cipher, notify: () => undefined, broadcast: () => undefined, nasDriverFactory: factory })
    engine.settings.load()

    const draft = { name: 'Syno', kind: 'synology' as const, host: '10.0.0.5', port: 5001, protocol: 'https' as const, username: 'bcenter', secret: 'mot-de-passe-nas', pinnedFingerprint: null }
    expect(await engine.api.testNas(draft)).toEqual({ otpRequired: true })
    expect(await engine.api.testNas({ ...draft, otp: '123456' })).toEqual({ version: 'DSM 7.2' })
    const saved = await engine.api.saveNas(draft)
    expect(engine.secrets.get(secretKeys.nasDevice(saved.id))).toBe('device-123')
    engine.db.exec('PRAGMA wal_checkpoint(FULL)')
    expect(readFileSync(join(dir, 'bcenter.sqlite')).includes('mot-de-passe-nas')).toBe(false)

    await engine.api.refreshNas()
    expect(seen.at(-1)).toMatchObject({ secret: 'mot-de-passe-nas', deviceToken: 'device-123' })
    expect(await engine.api.nasAction(saved.id, { kind: 'task', id: 'hb:1' })).toBe('ok')
    expect(actions).toEqual([{ kind: 'task', id: 'hb:1' }])

    await expect(engine.api.saveNas({ ...draft, kind: 'truenas', protocol: 'http', username: null })).rejects.toThrow(/HTTPS/)
    await engine.api.removeNas(saved.id)
    expect(engine.secrets.get(secretKeys.nasSecret(saved.id))).toBeNull()
    expect(engine.secrets.get(secretKeys.nasDevice(saved.id))).toBeNull()
  })
})

describe('alertes NAS', () => {
  it('indépendantes des alertes Proxmox', () => {
    const notify = vi.fn()
    const alerts = new AlertEngine(notify)
    const settings = { cpuThreshold: 0.9, memThreshold: 0.9, storageThreshold: 0.85 } as never
    const nas = { id: 'n', name: 'TrueNAS' } as NasProfile
    const snap: NasSnapshot = {
      ...emptyData(), nas, timestamp: '', reachable: true,
      pools: [{ id: 'tank', name: 'tank', kind: 'pool', status: 'degraded', used: 96, total: 100, canScrub: true }],
      disks: [{ id: 'sda', name: 'sda', size: 1, health: 'failing' }],
      alerts: [{ id: 'x', level: 'info', message: 'info seulement' }],
    }
    alerts.evaluateNas([snap], settings)
    expect(alerts.list().active.map((a) => a.title).sort()).toEqual(['Disque défaillant', 'Stockage dégradé', 'Stockage presque plein'])
    expect(notify).toHaveBeenCalledTimes(3)

    // Une évaluation Proxmox ne résout pas les alertes NAS.
    const server: ServerProfile = { id: 's', name: 'lab', host: 'h', port: 1, tokenId: 'x', pinnedFingerprint: null, createdAt: '' }
    alerts.evaluate([{ server, timestamp: '', reachable: true, nodes: [], guests: [], storages: [] }], settings)
    expect(alerts.list().active).toHaveLength(3)

    alerts.evaluateNas([{ ...snap, reachable: false, error: 'timeout', pools: [], disks: [] }], settings)
    expect(alerts.list().active.map((a) => a.title)).toEqual(['NAS injoignable'])
  })
})
