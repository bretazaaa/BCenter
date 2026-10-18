import type { GuestInfo, InfraSnapshot, MetricPoint, NodeInfo, RemoteTask, ServerProfile, SnapshotInfo, StorageInfo } from '@shared/types'

// Lecture tolérante du JSON Proxmox (certains nombres arrivent en chaînes).
type J = Record<string, unknown>
const num = (o: J, k: string): number | undefined => {
  const v = o[k]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}
const n0 = (o: J, k: string) => num(o, k) ?? 0
const str = (o: J, k: string): string | undefined => (o[k] == null ? undefined : String(o[k]))
const items = (data: unknown): J[] => (Array.isArray(data) ? (data as J[]) : [])

export function parseClusterResources(server: ServerProfile, data: unknown): InfraSnapshot {
  const nodes: NodeInfo[] = []
  const guests: GuestInfo[] = []
  const storages: StorageInfo[] = []

  for (const item of items(data)) {
    switch (str(item, 'type')) {
      case 'node':
        nodes.push({
          serverId: server.id,
          name: str(item, 'node') ?? str(item, 'id') ?? '?',
          status: str(item, 'status') === 'online' ? 'online' : str(item, 'status') === 'offline' ? 'offline' : 'unknown',
          cpu: n0(item, 'cpu'),
          cpuCount: n0(item, 'maxcpu'),
          memUsed: n0(item, 'mem'),
          memTotal: n0(item, 'maxmem'),
          diskUsed: n0(item, 'disk'),
          diskTotal: n0(item, 'maxdisk'),
          uptime: n0(item, 'uptime'),
        })
        break
      case 'qemu':
      case 'lxc': {
        const status = str(item, 'status')
        guests.push({
          serverId: server.id,
          node: str(item, 'node') ?? '?',
          vmid: n0(item, 'vmid'),
          name: str(item, 'name') ?? `#${n0(item, 'vmid')}`,
          kind: str(item, 'type') === 'lxc' ? 'lxc' : 'qemu',
          status: status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : status === 'paused' || status === 'suspended' ? 'paused' : 'unknown',
          cpu: n0(item, 'cpu'),
          cpuCount: n0(item, 'maxcpu'),
          memUsed: n0(item, 'mem'),
          memTotal: n0(item, 'maxmem'),
          diskTotal: n0(item, 'maxdisk'),
          netIn: n0(item, 'netin'),
          netOut: n0(item, 'netout'),
          uptime: n0(item, 'uptime'),
          template: n0(item, 'template') > 0,
          tags: (str(item, 'tags') ?? '').split(/[;, ]/).filter(Boolean),
        })
        break
      }
      case 'storage':
        storages.push({
          serverId: server.id,
          node: str(item, 'node') ?? '?',
          name: str(item, 'storage') ?? '?',
          type: str(item, 'plugintype'),
          used: n0(item, 'disk'),
          total: n0(item, 'maxdisk'),
          shared: n0(item, 'shared') > 0,
          content: (str(item, 'content') ?? '').split(',').filter(Boolean),
          active: str(item, 'status') === undefined || str(item, 'status') === 'available',
        })
        break
    }
  }

  return {
    server,
    timestamp: new Date().toISOString(),
    reachable: true,
    nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
    guests: guests.sort((a, b) => a.vmid - b.vmid),
    storages: storages.sort((a, b) => a.node.localeCompare(b.node) || a.name.localeCompare(b.name)),
  }
}

export function parseRrd(data: unknown, guest: boolean): MetricPoint[] {
  return items(data)
    .filter((p) => num(p, 'time') !== undefined && num(p, 'cpu') !== undefined)
    .map((p) => ({
      time: n0(p, 'time') * 1000,
      cpu: num(p, 'cpu'),
      memUsed: num(p, guest ? 'mem' : 'memused'),
      memTotal: num(p, guest ? 'maxmem' : 'memtotal'),
      netIn: num(p, 'netin'),
      netOut: num(p, 'netout'),
      loadAvg: num(p, 'loadavg'),
      ioWait: num(p, 'iowait'),
    }))
}

export function taskState(status: string | undefined, ended: boolean): RemoteTask['state'] {
  if (!ended && !status) return 'running'
  if (status === 'running') return 'running'
  if (status === 'OK' || status?.startsWith('WARNINGS')) return 'ok'
  return 'failed'
}

export function parseTask(t: J): RemoteTask {
  const ended = n0(t, 'endtime') > 0
  return {
    id: str(t, 'upid') ?? '?',
    node: str(t, 'node') ?? '?',
    type: str(t, 'type') ?? '?',
    user: str(t, 'user'),
    objectId: str(t, 'id'),
    startedAt: n0(t, 'starttime') * 1000,
    endedAt: ended ? n0(t, 'endtime') * 1000 : undefined,
    state: taskState(str(t, 'status'), ended),
    exitStatus: str(t, 'status'),
  }
}

export function parseTasks(data: unknown): RemoteTask[] {
  return items(data).map(parseTask)
}

/** Snapshots d'un invité ; l'entrée « current » (état courant) est ignorée. */
export function parseSnapshots(data: unknown): SnapshotInfo[] {
  return items(data)
    .filter((s) => str(s, 'name') && str(s, 'name') !== 'current')
    .map((s) => ({
      name: str(s, 'name')!,
      description: str(s, 'description')?.trim(),
      createdAt: num(s, 'snaptime') ? n0(s, 'snaptime') * 1000 : undefined,
    }))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
}

const usableAddress = (a: string) => !a.startsWith('127.') && !a.toLowerCase().startsWith('fe80') && a !== '::1'

export function parseQemuAgentAddresses(data: unknown): string[] {
  const result = (data as J | null)?.result ?? data
  return items(result)
    .filter((i) => str(i, 'name') !== 'lo')
    .flatMap((i) => items(i['ip-addresses']))
    .map((ip) => ({ address: str(ip, 'ip-address'), type: str(ip, 'ip-address-type') }))
    .filter((ip): ip is { address: string; type: string | undefined } => !!ip.address && usableAddress(ip.address))
    .sort((a, b) => (a.type === 'ipv4' ? 0 : 1) - (b.type === 'ipv4' ? 0 : 1))
    .map((ip) => ip.address)
}

export function parseLxcInterfaces(data: unknown): string[] {
  return items(data)
    .filter((i) => str(i, 'name') !== 'lo')
    .flatMap((i) => [str(i, 'inet'), str(i, 'inet6')])
    .filter((a): a is string => !!a)
    .map((a) => a.split('/')[0])
    .filter(usableAddress)
    .sort((a, b) => (a.includes(':') ? 1 : 0) - (b.includes(':') ? 1 : 0))
}
