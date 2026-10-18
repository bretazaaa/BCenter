import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobInfo, ScanResult, ServerProfile, SnapshotInfo, SshTarget } from '@shared/types'
import { secretKeys, type SecretCipher } from './data/secrets'
import { Engine } from './engine'
import { AlertEngine } from './services/alerts'
import type { GuestRef, VirtualizationProvider } from './services/provider'
import { snapshotName } from './services/snapshots'
import type { RemoteMaintenance } from './ssh/client'

/** Chiffrement factice réversible (DPAPI n'existe pas hors Windows/Electron). */
const cipher: SecretCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s, 'utf8').map((b) => b ^ 0x5a) as Buffer,
  decrypt: (d) => Buffer.from(d.map((b) => b ^ 0x5a)).toString('utf8'),
}

class FakeProvider implements Partial<VirtualizationProvider> {
  calls: string[] = []
  snapshotOk = true
  snapshots: SnapshotInfo[] = []
  async createSnapshot(_s: ServerProfile, g: GuestRef) { this.calls.push(`snapshot:${g.vmid}`); return 'UPID:1' }
  async rollbackSnapshot(_s: ServerProfile, _g: GuestRef, name: string) { this.calls.push(`rollback:${name}`); return 'UPID:2' }
  async deleteSnapshot(_s: ServerProfile, _g: GuestRef, name: string) { this.calls.push(`delete:${name}`); return 'UPID:3' }
  async listSnapshots() { return this.snapshots }
  async waitForTask(_s: ServerProfile, node: string, id: string) {
    return { id, node, type: 'qmsnapshot', startedAt: 0, state: this.snapshotOk || id !== 'UPID:1' ? ('ok' as const) : ('failed' as const), exitStatus: 'x' }
  }
}

class FakeRemote implements Partial<RemoteMaintenance> {
  calls: string[] = []
  async upgrade(t: SshTarget) { this.calls.push(`upgrade:${t.name}`); return { rebootRequired: true } }
  async scan(t: SshTarget): Promise<ScanResult> {
    return { targetId: t.id, scannedAt: '', packages: [{ name: 'openssl', security: true }], rebootRequired: false, system: { hostname: t.name, packageManager: 'apt', isRoot: true } }
  }
}

describe('moteur', () => {
  let dir: string
  let engine: Engine
  let provider: FakeProvider
  let remote: FakeRemote
  const finished: JobInfo[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bcenter-'))
    provider = new FakeProvider()
    remote = new FakeRemote()
    finished.length = 0
    engine = new Engine({
      dataDir: dir, cipher, notify: () => undefined,
      broadcast: (event, payload) => {
        if (event === 'job' && ['succeeded', 'failed', 'cancelled'].includes((payload as JobInfo).status)) finished.push(payload as JobInfo)
      },
      provider: provider as unknown as VirtualizationProvider,
      remote: remote as unknown as RemoteMaintenance,
    })
    engine.settings.load()
  })

  afterEach(() => {
    engine.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10))
    expect(predicate()).toBe(true)
  }

  const seed = () => {
    const server = { id: 's1', name: 'lab', host: 'pve', port: 8006, tokenId: 'a@b!c', pinnedFingerprint: null, createdAt: '' }
    engine.servers.upsert(server)
    engine.ssh.upsertCredential({ id: 'c1', name: 'c', username: 'root', authMethod: 'key', privateKeyPath: 'x', useSudo: true })
    const linked: SshTarget = { id: 't1', name: 'web', host: 'h', port: 22, credentialId: 'c1', hostKeyFingerprint: 'fp', hostKeyAlgorithm: 'ssh-ed25519', serverId: 's1', node: 'pve01', vmid: 101, guestKind: 'qemu' }
    const unlinked: SshTarget = { ...linked, id: 't2', name: 'dns', serverId: null, node: null, vmid: null, guestKind: null }
    engine.ssh.upsertTarget(linked)
    engine.ssh.upsertTarget(unlinked)
  }

  it('les secrets sont chiffrés dans SQLite et effacés avec le serveur', async () => {
    await engine.api.saveServer({ name: 'lab', host: 'pve', port: 8006, tokenId: 'a@b!c', tokenSecret: 'super-secret-token', pinnedFingerprint: 'ab:cd' })
    const [server] = engine.servers.list()
    expect(server.pinnedFingerprint).toBe('ABCD')
    expect(engine.secrets.get(secretKeys.serverToken(server.id))).toBe('super-secret-token')
    engine.db.exec('PRAGMA wal_checkpoint(FULL)')
    expect(readFileSync(join(dir, 'bcenter.sqlite')).includes('super-secret-token')).toBe(false)
    await engine.api.removeServer(server.id)
    expect(engine.secrets.get(secretKeys.serverToken(server.id))).toBeNull()
  })

  it('snapshot avant la mise à jour, puis mise à jour', async () => {
    seed()
    await engine.api.upgrade(['t1'], { snapshotFirst: true, fullUpgrade: false, rebootIfRequired: false })
    await until(() => finished.length === 1)
    expect(finished[0].status).toBe('succeeded')
    expect(finished[0].snapshotName).toMatch(/^bcenter-/)
    expect([...provider.calls, ...remote.calls]).toEqual(['snapshot:101', 'upgrade:web'])
    expect(engine.alerts.list().active.map((a) => a.title)).toContain('Redémarrage requis')
    expect(engine.history.recent(10)[0].log).toContain('Snapshot')
  })

  it('la mise à jour est annulée si le snapshot échoue', async () => {
    seed()
    provider.snapshotOk = false
    await engine.api.upgrade(['t1'], { snapshotFirst: true, fullUpgrade: false, rebootIfRequired: false })
    await until(() => finished.length === 1)
    expect(finished[0].status).toBe('failed')
    expect(remote.calls).toEqual([])
  })

  it('une machine non liée est mise à jour sans snapshot', async () => {
    seed()
    await engine.api.upgrade(['t2'], { snapshotFirst: true, fullUpgrade: false, rebootIfRequired: false })
    await until(() => finished.length === 1)
    expect(provider.calls).toEqual([])
    expect(remote.calls).toEqual(['upgrade:dns'])
  })

  it('restauration et purge des seuls snapshots BCenter expirés', async () => {
    seed()
    await engine.api.rollback('t1', 'bcenter-20260101-000000')
    await until(() => finished.length === 1)
    expect(provider.calls).toEqual(['rollback:bcenter-20260101-000000'])

    provider.calls = []
    provider.snapshots = [
      { name: snapshotName(new Date(Date.now() - 10 * 86_400_000)), createdAt: Date.now() - 10 * 86_400_000 },
      { name: snapshotName(new Date(Date.now() - 86_400_000)), createdAt: Date.now() - 86_400_000 },
      { name: 'avant-migration', createdAt: Date.now() - 60 * 86_400_000 },
    ]
    expect(await engine.snapshots.prune()).toBe(1)
    expect(provider.calls).toEqual([`delete:${provider.snapshots[0].name}`])
  })

  it('analyse : résultat conservé et résumé', async () => {
    seed()
    await engine.api.scan(['t2'])
    await until(() => finished.length === 1)
    expect(finished[0].summary).toContain('1 mise(s) à jour disponible(s), dont 1 de sécurité')
    expect((await engine.api.latestScans()).t2.packages).toHaveLength(1)
  })
})

describe('alertes', () => {
  it('lève puis résout une alerte, notifie une seule fois', () => {
    const notify = vi.fn()
    const alerts = new AlertEngine(notify)
    const server: ServerProfile = { id: 's', name: 'lab', host: 'h', port: 1, tokenId: 'x', pinnedFingerprint: null, createdAt: '' }
    const node = { serverId: 's', name: 'pve01', status: 'online' as const, cpu: 0.97, cpuCount: 4, memUsed: 1, memTotal: 10, diskUsed: 0, diskTotal: 0, uptime: 0 }
    const snap = (cpu: number) => [{ server, timestamp: '', reachable: true, nodes: [{ ...node, cpu }], guests: [], storages: [] }]
    const settings = { cpuThreshold: 0.9, memThreshold: 0.9, storageThreshold: 0.85 } as never
    alerts.evaluate(snap(0.97), settings)
    alerts.evaluate(snap(0.97), settings)
    expect(alerts.list().active).toHaveLength(1)
    expect(notify).toHaveBeenCalledTimes(1)
    alerts.evaluate(snap(0.2), settings)
    expect(alerts.list().active).toHaveLength(0)
    expect(alerts.list().history[0].resolvedAt).toBeDefined()
  })
})
