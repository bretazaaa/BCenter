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
  testConnection?: RemoteMaintenance['testConnection']
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
    const linked: SshTarget = { id: 't1', name: 'web', host: 'h', port: 22, credentialId: 'c1', hostKeyFingerprint: 'fp', hostKeyAlgorithm: 'ssh-ed25519', serverId: 's1', node: 'pve01', vmid: 101, guestKind: 'qemu', group: null, tags: [] }
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

  it('connexions : dossier et tags modifiables, adresse et clé d’hôte inchangées', async () => {
    seed()
    const updated = await engine.api.updateTarget('t2', { name: ' dns-01 ', group: ' Réseau ', tags: ['dns', ' dns', '', 'lab'] })
    expect(updated).toMatchObject({ name: 'dns-01', group: 'Réseau', tags: ['dns', 'lab'], host: 'h', hostKeyFingerprint: 'fp' })
    expect(engine.ssh.targets().find((t) => t.id === 't2')).toMatchObject({ group: 'Réseau', tags: ['dns', 'lab'] })
    await engine.api.updateTarget('t2', { group: null })
    expect(engine.ssh.targets().find((t) => t.id === 't2')?.group).toBeNull()
    await expect(engine.api.updateTarget('t2', { credentialId: 'inconnu' })).rejects.toThrow(/introuvables/)
  })

  it('import : mot de passe saisi une fois, vérifié avant l’ajout, chiffré', async () => {
    const hostKey = { host: '', port: 22, algorithm: 'ssh-ed25519', fingerprint: 'fp' }
    const candidate = (name: string, host: string) => ({ id: name, source: 'xpipe' as const, name, host, port: 22, username: 'bob', keyPath: null, group: 'Lab', existingTargetId: null })
    remote.testConnection = async (t) => {
      if (t.host === 'down') throw new Error('Authentification SSH refusée')
      return { hostname: t.name, packageManager: 'apt' as const, isRoot: false }
    }
    const result = await engine.api.importConnections([
      { candidate: candidate('a', 'h1'), hostKey, credentialId: 'password', password: 'p4ss-import' },
      { candidate: candidate('b', 'h2'), hostKey, credentialId: 'password', password: 'p4ss-import' },
      { candidate: candidate('c', 'down'), hostKey, credentialId: 'password', password: 'autre' },
    ])
    expect(result.added).toBe(2)
    expect(result.errors.map((e) => e.name)).toEqual(['c'])
    // Un seul identifiant pour le même utilisateur et mot de passe ; celui de l'échec est supprimé.
    const creds = engine.ssh.credentials()
    expect(creds).toHaveLength(1)
    expect(engine.secrets.get(secretKeys.sshPassword(creds[0].id))).toBe('p4ss-import')
    expect(engine.ssh.targets().map((t) => [t.name, t.group, t.tags])).toEqual([['a', 'Lab', ['xpipe']], ['b', 'Lab', ['xpipe']]])
    engine.db.exec('PRAGMA wal_checkpoint(FULL)')
    expect(readFileSync(join(dir, 'bcenter.sqlite')).includes('p4ss-import')).toBe(false)
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
