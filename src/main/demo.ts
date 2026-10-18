import type {
  CertificateInfo,
  GuestInfo,
  HostKeyInfo,
  InfraSnapshot,
  JobLogLine,
  MetricPoint,
  NasAction,
  NasDisk,
  NasProfile,
  RemoteSystem,
  RemoteTask,
  ScanResult,
  ServerProfile,
  SnapshotInfo,
  SshTarget,
} from '@shared/types'
import type { Engine, EnginePorts } from './engine'
import type { NasData, NasDriver } from './nas/driver'
import { secretKeys } from './data/secrets'
import { snapshotName } from './services/snapshots'
import type { GuestRef, VirtualizationProvider } from './services/provider'
import type { RemoteMaintenance, ShellHandle } from './ssh/client'

/**
 * Mode démonstration (`--demo`) : vraie interface et vrai moteur, mais Proxmox et SSH simulés.
 * Données isolées dans %LOCALAPPDATA%\BCenter-demo.
 */
export function createDemoPorts(ports: EnginePorts): EnginePorts {
  return { ...ports, provider: new DemoProvider(), remote: new DemoRemote(), nasDriverFactory: (nas) => new DemoNasDriver(nas) }
}

const DEMO_SERVER_ID = '00000000-0000-4000-8000-000000000001'
const DEMO_CREDENTIAL_ID = '00000000-0000-4000-8000-000000000002'

export function seedDemo(engine: Engine): void {
  if (engine.nasRepo.list().length === 0) seedDemoNas(engine)
  if (engine.servers.list().length > 0) return
  engine.servers.upsert({ id: DEMO_SERVER_ID, name: 'Cluster Lab', host: 'pve01.lab.lan', port: 8006, tokenId: 'root@pam!bcenter', pinnedFingerprint: 'AB', createdAt: new Date().toISOString() })
  engine.secrets.set(secretKeys.serverToken(DEMO_SERVER_ID), 'demo')
  if (process.env.BCENTER_DEMO_SETUP === '1') engine.settings.save({ ...engine.settings.value, setupCompleted: true, refreshInterval: 5 })
  engine.ssh.upsertCredential({ id: DEMO_CREDENTIAL_ID, name: 'Identifiants par défaut', username: 'root', authMethod: 'key', privateKeyPath: 'C:\\demo\\id_ed25519', useSudo: true })
  const base = { port: 22, credentialId: DEMO_CREDENTIAL_ID, hostKeyFingerprint: 'uK6t3m0gVnq3xGQm1c4rXq8wVJ1kq0Yb9f0dE7mZp2s', hostKeyAlgorithm: 'ssh-ed25519' }
  const targets: SshTarget[] = [
    { ...base, id: 'demo-web', name: 'web-01', host: '10.0.0.21', serverId: DEMO_SERVER_ID, node: 'pve01', vmid: 101, guestKind: 'qemu' },
    { ...base, id: 'demo-db', name: 'db-01', host: '10.0.0.22', serverId: DEMO_SERVER_ID, node: 'pve02', vmid: 102, guestKind: 'qemu' },
    { ...base, id: 'demo-dns', name: 'dns', host: '10.0.0.53', serverId: DEMO_SERVER_ID, node: 'pve01', vmid: 103, guestKind: 'lxc' },
    { ...base, id: 'demo-nas', name: 'nas-legacy', host: '10.0.0.80', serverId: null, node: null, vmid: null, guestKind: null },
  ]
  for (const t of targets) engine.ssh.upsertTarget(t)
}

const GB = 1024 ** 3
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('Annulé'))
    })
  })

class DemoProvider implements VirtualizationProvider {
  private tick = 0
  private readonly snapshots = new Map<number, SnapshotInfo[]>([
    [101, [{ name: snapshotName(new Date(Date.now() - 20 * 3600_000)), description: 'BCenter — avant mise à jour', createdAt: Date.now() - 20 * 3600_000 }]],
  ])

  async probeCertificate(host: string): Promise<CertificateInfo> {
    await wait(400)
    return {
      subject: `CN=${host}, OU=PVE Cluster Node, O=Proxmox Virtual Environment`,
      issuer: 'CN=Proxmox Virtual Environment, OU=7f3c2b1a, O=PVE Cluster Manager CA',
      fingerprint: '3FA94C12D08B77E1A6C55B2E901F6C4A2D7E88B1C3F09A5D6E4B2C1A0F9E8D7C',
      validFrom: new Date(Date.now() - 365 * 86_400_000).toISOString(),
      validTo: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      trustedBySystem: false,
      validationError: 'self-signed certificate in certificate chain',
    }
  }

  async testConnection() {
    await wait(600)
    return { version: 'Proxmox VE 8.4.1' }
  }

  async getSnapshot(server: ServerProfile): Promise<InfraSnapshot> {
    this.tick++
    const wave = (i: number, amp: number) => Math.max(0, Math.min(1, amp * (0.5 + 0.5 * Math.sin(this.tick / 4 + i)) + Math.random() * 0.08))
    const nodes = ['pve01', 'pve02', 'pve03'].map((name, i) => ({
      serverId: server.id, name, status: i === 2 ? ('offline' as const) : ('online' as const),
      cpu: i === 2 ? 0 : 0.18 + wave(i, 0.45), cpuCount: 32, memUsed: (90 + i * 55 + Math.random() * 8) * GB, memTotal: 256 * GB,
      diskUsed: 41 * GB, diskTotal: 100 * GB, uptime: (23 + i) * 86_400, version: 'pve-manager/8.4.1/2a5fa54a8503f96d',
    }))
    const names = ['web-01', 'db-01', 'dns', 'mail', 'gitlab', 'monitoring', 'backup-proxy', 'vpn', 'ha-proxy', 'redis', 'minio', 'build-agent']
    const guests: GuestInfo[] = names.map((name, i) => ({
      serverId: server.id, node: i === 1 || i % 2 === 1 ? 'pve02' : 'pve01', vmid: 101 + i, name,
      kind: i === 2 || i % 3 === 2 ? 'lxc' : 'qemu', status: i === 7 ? 'stopped' : 'running',
      cpu: i === 7 ? 0 : wave(i, 0.7), cpuCount: 4, memUsed: (1 + ((i * 37) % 6) + Math.random()) * GB, memTotal: 8 * GB,
      diskTotal: 64 * GB, netIn: this.tick * (i + 1) * 4e6, netOut: this.tick * (i + 1) * 1.5e6, uptime: (30 + i * 7) * 3600,
      template: false, tags: i % 4 === 0 ? ['prod', 'web'] : ['lab'],
    }))
    return {
      server, timestamp: new Date().toISOString(), reachable: true, nodes, guests,
      storages: [
        { serverId: server.id, node: 'pve01', name: 'local-lvm', type: 'lvmthin', used: 620 * GB, total: 900 * GB, shared: false, content: ['images', 'rootdir'], active: true },
        { serverId: server.id, node: 'pve01', name: 'pbs', type: 'pbs', used: 3100 * GB, total: 4000 * GB, shared: true, content: ['backup'], active: true },
        { serverId: server.id, node: 'pve02', name: 'ceph', type: 'rbd', used: 5200 * GB, total: 6000 * GB, shared: true, content: ['images'], active: true },
      ],
    }
  }

  async getNodeMetrics(): Promise<MetricPoint[]> {
    return this.rrd()
  }

  async getGuestMetrics(): Promise<MetricPoint[]> {
    return this.rrd()
  }

  async getRecentTasks(): Promise<RemoteTask[]> {
    const now = Date.now()
    return [
      { id: '1', node: 'pve01', type: 'vzdump', objectId: '101', user: 'root@pam', startedAt: now - 35 * 60_000, state: 'ok' },
      { id: '2', node: 'pve02', type: 'qmstart', objectId: '108', user: 'root@pam', startedAt: now - 2 * 3600_000, state: 'ok' },
      { id: '3', node: 'pve01', type: 'qmigrate', objectId: '104', user: 'root@pam', startedAt: now - 5 * 3600_000, state: 'failed' },
    ]
  }

  async powerAction() {
    await wait(300)
    return 'UPID'
  }

  async guestAddresses(_s: ServerProfile, guest: GuestInfo) {
    await wait(500)
    return [`10.0.0.${20 + (guest.vmid - 100)}`]
  }

  async listSnapshots(_s: ServerProfile, guest: GuestRef) {
    return this.snapshots.get(guest.vmid) ?? []
  }

  async createSnapshot(_s: ServerProfile, guest: GuestRef, name: string, description: string) {
    await wait(1500)
    this.snapshots.set(guest.vmid, [...(this.snapshots.get(guest.vmid) ?? []), { name, description, createdAt: Date.now() }])
    return 'UPID:snapshot'
  }

  async rollbackSnapshot() {
    return 'UPID:rollback'
  }

  async deleteSnapshot(_s: ServerProfile, guest: GuestRef, name: string) {
    this.snapshots.set(guest.vmid, (this.snapshots.get(guest.vmid) ?? []).filter((s) => s.name !== name))
    return 'UPID:delete'
  }

  async waitForTask(_s: ServerProfile, node: string, taskId: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RemoteTask> {
    for (const l of ['Task started', taskId.includes('rollback') ? 'rolling back to snapshot…' : 'saving VM configuration…', 'TASK OK']) {
      await wait(500, signal)
      onLine?.(l)
    }
    return { id: taskId, node, type: 'qmsnapshot', startedAt: Date.now(), state: 'ok', exitStatus: 'OK' }
  }

  private rrd(): MetricPoint[] {
    return Array.from({ length: 70 }, (_, i) => ({
      time: Date.now() - (70 - i) * 60_000,
      cpu: 0.25 + 0.15 * Math.sin(i / 6) + Math.random() * 0.06,
      memUsed: 90e9 + 8e9 * Math.sin(i / 10),
      memTotal: 256e9,
      netIn: 2e6 + 1e6 * Math.sin(i / 4),
      netOut: 1e6 + 5e5 * Math.cos(i / 5),
      loadAvg: 3 + Math.sin(i / 7),
      ioWait: 0.01 + Math.random() * 0.02,
    }))
  }
}

class DemoRemote implements RemoteMaintenance {
  async probeHostKey(host: string, port: number): Promise<HostKeyInfo> {
    await wait(500)
    return { host, port, algorithm: 'ssh-ed25519', fingerprint: 'uK6t3m0gVnq3xGQm1c4rXq8wVJ1kq0Yb9f0dE7mZp2s' }
  }

  async testConnection(target: SshTarget): Promise<RemoteSystem> {
    await wait(700)
    return { hostname: target.name, osName: 'Debian GNU/Linux', osVersion: '12', kernel: '6.1.0-26-amd64', packageManager: 'apt', isRoot: true }
  }

  async scan(target: SshTarget, _c: unknown, _s: unknown, log: (l: JobLogLine) => void, signal?: AbortSignal): Promise<ScanResult> {
    for (const l of ['Hit:1 http://deb.debian.org/debian bookworm InRelease', 'Get:2 http://security.debian.org bookworm-security InRelease [48,0 kB]', 'Reading package lists...']) {
      await wait(350, signal)
      log({ time: Date.now(), level: 'output', text: l })
    }
    const none = target.name === 'dns'
    return {
      targetId: target.id,
      scannedAt: new Date().toISOString(),
      system: { hostname: target.name, osName: 'Debian GNU/Linux', osVersion: '12', packageManager: 'apt', isRoot: true },
      packages: none ? [] : [
        { name: 'openssl', currentVersion: '3.0.14-1~deb12u2', newVersion: '3.0.15-1~deb12u1', security: true },
        { name: 'curl', currentVersion: '7.88.1-10+deb12u7', newVersion: '7.88.1-10+deb12u8', security: false },
        { name: 'nginx', currentVersion: '1.22.1-9', newVersion: '1.22.1-9+deb12u1', security: target.name === 'web-01' },
      ],
      rebootRequired: target.name === 'db-01',
    }
  }

  async upgrade(_t: SshTarget, _c: unknown, _s: unknown, _o: unknown, log: (l: JobLogLine) => void, signal?: AbortSignal) {
    const lines = [
      'Reading package lists...', 'Building dependency tree...', 'Reading state information...', 'Calculating upgrade...',
      'The following packages will be upgraded:', '  curl libcurl4 nginx openssl',
      '4 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.', 'Need to get 4 812 kB of archives.',
      'Get:1 http://security.debian.org bookworm-security/main amd64 openssl amd64 3.0.15-1~deb12u1 [1 422 kB]',
      'Unpacking openssl (3.0.15-1~deb12u1) over (3.0.14-1~deb12u2) ...', 'Setting up openssl (3.0.15-1~deb12u1) ...',
      'Setting up curl (7.88.1-10+deb12u8) ...', 'Processing triggers for man-db (2.11.2-2) ...',
    ]
    for (const text of lines) {
      await wait(450, signal)
      log({ time: Date.now(), level: 'output', text })
    }
    return { rebootRequired: Math.random() > 0.5 }
  }

  async openShell(target: SshTarget, _c: unknown, _s: unknown, _size: unknown, onData: (data: string) => void, onClose: () => void) {
    await wait(600)
    return demoShell(target, onData, onClose)
  }

  async reboot(_t: SshTarget, _c: unknown, _s: unknown, log: (l: JobLogLine) => void) {
    await wait(600)
    log({ time: Date.now(), level: 'info', text: 'Redémarrage programmé dans 2 secondes.' })
  }
}

/** Shell simulé du mode démonstration (quelques commandes courantes). */
function demoShell(target: SshTarget, onData: (data: string) => void, onClose: () => void): ShellHandle {
  const prompt = `\x1b[1;32mroot@${target.name}\x1b[0m:\x1b[1;34m~\x1b[0m# `
  const outputs: Record<string, string> = {
    help: 'Shell de démonstration BCenter. Commandes : ls, uname -a, uptime, df -h, free -h, hostname, whoami, apt list --upgradable, clear, exit',
    ls: 'backup.sh  docker-compose.yml  logs  scripts',
    'uname -a': `Linux ${target.name} 6.1.0-26-amd64 #1 SMP PREEMPT_DYNAMIC Debian 6.1.112-1 x86_64 GNU/Linux`,
    uptime: ' 17:42:08 up 12 days,  3:14,  1 user,  load average: 0,18, 0,22, 0,19',
    'df -h': 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        62G   18G   41G  31% /\ntmpfs           3,9G     0  3,9G   0% /dev/shm',
    'free -h': '               total        used        free      shared  buff/cache   available\nMem:           7,8Gi       2,1Gi       3,9Gi        12Mi       1,8Gi       5,4Gi\nSwap:          975Mi          0B       975Mi',
    hostname: target.name,
    whoami: 'root',
    'apt list --upgradable': 'Listing... Done\nopenssl/stable-security 3.0.15-1~deb12u1 amd64 [upgradable from: 3.0.14-1~deb12u2]\ncurl/stable 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]',
  }
  let line = ''
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    onClose()
  }
  setTimeout(() => onData(`Linux ${target.name} 6.1.0-26-amd64 x86_64\r\n\r\nShell de démonstration — tapez « help ».\r\n${prompt}`), 300)
  return {
    write(data) {
      for (const ch of data) {
        if (ch === '\r') {
          const cmd = line.trim()
          line = ''
          onData('\r\n')
          if (cmd === 'exit') {
            onData('logout\r\n')
            setTimeout(close, 200)
            return
          }
          if (cmd === 'clear') onData('\x1b[2J\x1b[H')
          else if (cmd) onData(`${(outputs[cmd] ?? `bash: ${cmd.split(' ')[0]}: command not found`).replaceAll('\n', '\r\n')}\r\n`)
          onData(prompt)
        } else if (ch === '\x7f') {
          if (line) {
            line = line.slice(0, -1)
            onData('\b \b')
          }
        } else if (ch === '\x03') {
          line = ''
          onData(`^C\r\n${prompt}`)
        } else if (ch >= ' ') {
          line += ch
          onData(ch)
        }
      }
    },
    resize() {},
    close,
  }
}

// ------------------------------------------------------------------ NAS simulés

const TB = 1024 ** 4

const DEMO_NAS = [
  { id: '00000000-0000-4000-8000-000000000011', name: 'TrueNAS', kind: 'truenas', host: '10.0.0.40', port: 443 },
  { id: '00000000-0000-4000-8000-000000000012', name: 'Synology', kind: 'synology', host: '10.0.0.41', port: 5001 },
  { id: '00000000-0000-4000-8000-000000000013', name: 'Backup Server', kind: 'pbs', host: '10.0.0.42', port: 8007 },
] as const

function seedDemoNas(engine: Engine): void {
  for (const n of DEMO_NAS) {
    engine.nasRepo.upsert({
      ...n, protocol: 'https', username: n.kind === 'synology' ? 'bcenter' : n.kind === 'pbs' ? 'bcenter@pbs!bcenter' : null,
      pinnedFingerprint: null, sshTargetId: n.kind === 'truenas' ? 'demo-nas' : null, createdAt: new Date().toISOString(),
    })
    engine.secrets.set(secretKeys.nasSecret(n.id), 'demo')
  }
}

/** NAS de démonstration : données réalistes, actions appliquées à l'état simulé. */
class DemoNasDriver implements NasDriver {
  private readonly data: NasData

  constructor(nas: NasProfile) {
    this.data = nas.kind === 'synology' ? demoSynology() : nas.kind === 'pbs' ? demoPbs() : demoTrueNas()
  }

  async test() {
    await wait(700)
    return { version: this.data.system.version ?? 'Démo' }
  }

  async snapshot(): Promise<NasData> {
    await wait(250)
    return { ...this.data, system: { ...this.data.system, cpu: 0.06 + Math.random() * 0.08, uptime: (this.data.system.uptime ?? 0) + Math.floor(process.uptime()) } }
  }

  async action(action: NasAction): Promise<string> {
    await wait(600)
    const d = this.data
    const verb = (op: 'start' | 'stop' | 'restart') => (op === 'stop' ? 'Arrêt' : op === 'start' ? 'Démarrage' : 'Redémarrage')
    switch (action.kind) {
      case 'service':
        d.services = d.services.map((s) => (s.id === action.id ? { ...s, running: action.op !== 'stop' } : s))
        return `${verb(action.op)} du service demandé.`
      case 'app':
        d.apps = d.apps.map((a) => (a.id === action.id ? { ...a, state: action.op === 'stop' ? 'stopped' : 'running', stateText: action.op === 'stop' ? 'STOPPED' : 'RUNNING' } : a))
        return `${verb(action.op)} demandé.`
      case 'task':
        d.tasks = d.tasks.map((t) => (t.id === action.id ? { ...t, state: 'ok', lastRun: Date.now() } : t))
        return 'Tâche lancée sur le NAS.'
      case 'scrub':
        d.pools = d.pools.map((p) => (p.id === action.poolId ? { ...p, scrub: { running: true, lastRun: Date.now(), errors: 0 } } : p))
        return `Scrub du pool ${action.poolId} lancé.`
      case 'update':
        d.system = { ...d.system, updates: { available: false } }
        return 'Mise à jour lancée : le NAS redémarrera à la fin de l’installation.'
      case 'power':
        return action.op === 'reboot' ? 'Redémarrage du NAS demandé (simulation).' : 'Arrêt du NAS demandé (simulation).'
    }
  }

  close(): void {}
}

function demoTrueNas(): NasData {
  const now = Date.now()
  const disk = (i: number, pool: string, size: number, model: string, health: NasDisk['health'] = 'ok'): NasDisk => ({
    id: `{serial}WD-${1000 + i}`, name: `sd${String.fromCharCode(97 + i)}`, model, serial: `WD-WX${71230 + i}`, size, temperature: 31 + (i % 4) * 2, pool,
    health, healthText: health === 'ok' ? 'En ligne' : '3 erreur(s) E/S',
  })
  return {
    system: { hostname: 'truenas', model: 'Supermicro X11SCH-F', version: 'TrueNAS-25.04.2', uptime: 41 * 86_400, memTotal: 64 * GB, updates: { available: true, version: '25.04.2.1' } },
    pools: [
      { id: 'tank', name: 'tank', kind: 'pool', status: 'healthy', statusText: 'ONLINE', used: 21.4 * TB, total: 32 * TB, detail: 'ZFS · RAIDZ2', scrub: { running: false, lastRun: now - 6 * 86_400_000, errors: 0 }, canScrub: true },
      { id: 'fast', name: 'fast', kind: 'pool', status: 'healthy', statusText: 'ONLINE', used: 0.62 * TB, total: 1.8 * TB, detail: 'ZFS · MIRROR', scrub: { running: false, lastRun: now - 13 * 86_400_000, errors: 0 }, canScrub: true },
    ],
    disks: [
      ...[0, 1, 2, 3, 4].map((i) => disk(i, 'tank', 8e12, 'WDC WD80EFZZ-68BTXN0')),
      disk(5, 'tank', 8e12, 'WDC WD80EFZZ-68BTXN0', 'warning'),
      disk(6, 'fast', 2e12, 'Samsung SSD 990 PRO 2TB'),
      disk(7, 'fast', 2e12, 'Samsung SSD 990 PRO 2TB'),
    ],
    shares: [
      { id: 'smb:1', name: 'media', protocol: 'SMB', path: '/mnt/tank/media', enabled: true },
      { id: 'smb:2', name: 'documents', protocol: 'SMB', path: '/mnt/tank/documents', enabled: true, comment: 'Documents partagés' },
      { id: 'nfs:1', name: 'proxmox-backups', protocol: 'NFS', path: '/mnt/tank/proxmox-backups', enabled: true },
      { id: 'nfs:2', name: 'iso', protocol: 'NFS', path: '/mnt/fast/iso', enabled: false },
    ],
    services: [
      { id: 'cifs', name: 'SMB', running: true, enabled: true, controllable: true },
      { id: 'nfs', name: 'NFS', running: true, enabled: true, controllable: true },
      { id: 'ssh', name: 'SSH', running: true, enabled: true, controllable: true },
      { id: 'ups', name: 'UPS', running: false, enabled: false, controllable: true },
      { id: 'snmp', name: 'SNMP', running: false, enabled: false, controllable: true },
    ],
    apps: [
      { id: 'app:plex', name: 'plex', kind: 'app', state: 'running', stateText: 'RUNNING', version: '1.41.6', controllable: true },
      { id: 'app:nextcloud', name: 'nextcloud', kind: 'app', state: 'running', stateText: 'RUNNING', version: '31.0.4', updateAvailable: true, controllable: true },
      { id: 'app:immich', name: 'immich', kind: 'app', state: 'running', stateText: 'RUNNING', version: 'v1.132.3', controllable: true },
      { id: 'app:syncthing', name: 'syncthing', kind: 'app', state: 'stopped', stateText: 'STOPPED', version: '1.29.5', controllable: true },
      { id: 'vm:1', name: 'home-assistant', kind: 'vm', state: 'running', stateText: 'RUNNING', controllable: true },
    ],
    tasks: [
      { id: 'snap:1', name: 'Snapshots tank/documents', type: 'snapshot', detail: 'auto-%Y-%m-%d_%H-%M', enabled: true, lastRun: now - 40 * 60_000, state: 'ok', canRun: true },
      { id: 'snap:2', name: 'Snapshots tank/media', type: 'snapshot', detail: 'auto-%Y-%m-%d', enabled: true, lastRun: now - 9 * 3600_000, state: 'ok', canRun: true },
      { id: 'repl:1', name: 'tank → backup-nas', type: 'replication', enabled: true, lastRun: now - 5 * 3600_000, state: 'ok', canRun: true },
      { id: 'cloud:1', name: 'Documents → Backblaze B2', type: 'cloudsync', detail: '/mnt/tank/documents', enabled: true, lastRun: now - 26 * 3600_000, state: 'failed', canRun: true },
    ],
    alerts: [
      { id: 'a1', level: 'warning', message: 'Device /dev/sdf: 3 Currently unreadable (pending) sectors.', time: now - 3 * 3600_000 },
      { id: 'a2', level: 'info', message: 'An update is available for TrueNAS: 25.04.2.1.', time: now - 86_400_000 },
    ],
    capabilities: ['reboot', 'shutdown', 'update'],
  }
}

function demoSynology(): NasData {
  const now = Date.now()
  return {
    system: { hostname: 'syno-backup', model: 'DS920+', version: 'DSM 7.2.2-72806 Update 3', uptime: 12 * 86_400, temperature: 41, memUsed: 3.1 * GB, memTotal: 8 * GB },
    pools: [{ id: 'volume_1', name: 'Volume 1', kind: 'volume', status: 'healthy', statusText: 'normal', used: 9.6 * TB, total: 10.9 * TB, detail: 'btrfs · SHR WITH 1 DISK PROTECT', canScrub: false }],
    disks: [1, 2, 3, 4].map((i) => ({
      id: `sata${i}`, name: `Disque ${i}`, model: 'ST4000VN006-3CW104', serial: `ZW6${i}A1B2`, size: 4e12, temperature: 36 + i, pool: 'Volume 1', health: 'ok' as const, healthText: 'Normal',
    })),
    shares: ['homes', 'photo', 'video', 'backup', 'docker'].map((name) => ({ id: name, name, protocol: 'SMB / NFS', path: `/volume1/${name}`, enabled: true })),
    services: [
      { id: 'smb', name: 'SMB', running: true, enabled: true, controllable: false },
      { id: 'nfs', name: 'NFS', running: true, enabled: true, controllable: false },
      { id: 'ssh', name: 'SSH', running: true, enabled: true, controllable: false },
    ],
    apps: [
      { id: 'docker:vaultwarden', name: 'vaultwarden', kind: 'container', state: 'running', stateText: 'running', version: 'vaultwarden/server:latest', controllable: true },
      { id: 'docker:uptime-kuma', name: 'uptime-kuma', kind: 'container', state: 'running', stateText: 'running', version: 'louislam/uptime-kuma:1', controllable: true },
      { id: 'pkg:HyperBackup', name: 'Hyper Backup', kind: 'package', state: 'running', stateText: 'running', version: '4.1.2-4039', controllable: true },
      { id: 'pkg:SynologyPhotos', name: 'Synology Photos', kind: 'package', state: 'running', stateText: 'running', version: '1.7.1-10015', controllable: true },
      { id: 'pkg:ContainerManager', name: 'Container Manager', kind: 'package', state: 'running', stateText: 'running', version: '24.0.2-1543', controllable: true },
    ],
    tasks: [
      { id: 'hb:1', name: 'Sauvegarde vers C2', type: 'backup', detail: 'Hyper Backup', enabled: true, lastRun: now - 7 * 3600_000, state: 'ok', canRun: true },
      { id: 'hb:2', name: 'Copie USB hebdomadaire', type: 'backup', detail: 'Hyper Backup', enabled: true, lastRun: now - 4 * 86_400_000, state: 'ok', canRun: true },
    ],
    alerts: [],
    capabilities: ['reboot', 'shutdown'],
  }
}

function demoPbs(): NasData {
  const now = Date.now()
  return {
    system: { hostname: 'pbs', version: 'Proxmox Backup Server 3.4.1-1', uptime: 63 * 86_400, cpu: 0.04, memUsed: 5.2 * GB, memTotal: 16 * GB, updates: { available: true, count: 7 } },
    pools: [
      { id: 'main', name: 'main', kind: 'datastore', status: 'healthy', used: 3.1 * TB, total: 4 * TB, detail: 'Datastore', canScrub: false },
      { id: 'offsite', name: 'offsite', kind: 'datastore', status: 'healthy', used: 1.2 * TB, total: 8 * TB, detail: 'Datastore', canScrub: false },
    ],
    disks: [
      { id: 'nvme0n1', name: '/dev/nvme0n1', model: 'KINGSTON SNV2S500G', size: 5e11, health: 'ok', healthText: 'PASSED', pool: 'root' },
      { id: 'sda', name: '/dev/sda', model: 'ST4000NM000A', size: 4e12, health: 'ok', healthText: 'PASSED', pool: 'ZFS' },
    ],
    shares: [],
    services: [
      { id: 'proxmox-backup-proxy', name: 'proxmox-backup-proxy', running: true, enabled: true, controllable: false },
      { id: 'postfix', name: 'postfix', running: true, enabled: true, controllable: true },
      { id: 'chrony', name: 'chrony', running: true, enabled: true, controllable: true },
    ],
    apps: [],
    tasks: [
      { id: 'verify:v-main', name: 'Vérification main', type: 'verify', detail: 'daily', enabled: true, lastRun: now - 10 * 3600_000, state: 'ok', canRun: true },
      { id: 'prune:p-main', name: 'Élagage main', type: 'prune', detail: 'daily', enabled: true, lastRun: now - 11 * 3600_000, state: 'ok', canRun: true },
      { id: 'sync:s-offsite', name: 'Synchronisation main → offsite', type: 'sync', detail: 'sat 03:00', enabled: true, lastRun: now - 3 * 86_400_000, state: 'ok', canRun: true },
      { id: 'gc:main', name: 'Garbage collection main', type: 'gc', enabled: true, lastRun: now - 30 * 3600_000, state: 'ok', canRun: true },
    ],
    alerts: [],
    capabilities: ['reboot', 'shutdown'],
  }
}
