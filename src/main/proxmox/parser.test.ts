import { describe, expect, it } from 'vitest'
import type { ServerProfile } from '@shared/types'
import { parseClusterResources, parseLxcInterfaces, parseQemuAgentAddresses, parseSnapshots, taskState } from './parser'
import { fingerprintsMatch, formatFingerprint, normalizeFingerprint } from './tls'

const server: ServerProfile = { id: 's1', name: 'lab', host: 'pve', port: 8006, tokenId: 'a@b!c', pinnedFingerprint: null, createdAt: '' }

describe('API Proxmox', () => {
  it('répartit nœuds, invités et stockages', () => {
    const snap = parseClusterResources(server, [
      { type: 'node', node: 'pve01', status: 'online', cpu: 0.25, maxcpu: 16, mem: 8, maxmem: 32, uptime: 3600 },
      { type: 'node', node: 'pve02', status: 'offline' },
      { type: 'qemu', node: 'pve01', vmid: 101, name: 'web', status: 'running', tags: 'prod;web', template: 0 },
      { type: 'lxc', node: 'pve01', vmid: '102', name: 'dns', status: 'stopped' },
      { type: 'qemu', node: 'pve01', vmid: 9000, name: 'tpl', status: 'stopped', template: 1 },
      { type: 'storage', node: 'pve01', storage: 'local', plugintype: 'dir', disk: 50, maxdisk: 100, content: 'iso,backup', shared: 0, status: 'available' },
    ])
    expect(snap.nodes.map((n) => n.status)).toEqual(['online', 'offline'])
    expect(snap.guests).toHaveLength(3)
    expect(snap.guests[0]).toMatchObject({ vmid: 101, kind: 'qemu', status: 'running', tags: ['prod', 'web'] })
    expect(snap.guests[1]).toMatchObject({ vmid: 102, kind: 'lxc' })
    expect(snap.guests[2].template).toBe(true)
    expect(snap.storages[0]).toMatchObject({ name: 'local', used: 50, total: 100, content: ['iso', 'backup'] })
  })

  it.each([
    [undefined, false, 'running'],
    ['OK', true, 'ok'],
    ['WARNINGS: 1', true, 'ok'],
    ['job errors', true, 'failed'],
  ] as const)('état de tâche %s', (status, ended, expected) => expect(taskState(status, ended)).toBe(expected))

  it('snapshots : ignore « current » et trie par date', () => {
    const list = parseSnapshots([
      { name: 'current', description: 'You are here!' },
      { name: 'bcenter-20260101-120000', description: 'BCenter\n', snaptime: 1767268800 },
      { name: 'avant-migration', snaptime: 1767000000 },
    ])
    expect(list.map((s) => s.name)).toEqual(['avant-migration', 'bcenter-20260101-120000'])
    expect(list[1].description).toBe('BCenter')
  })

  it('adresses IP : agent QEMU et interfaces LXC', () => {
    expect(parseQemuAgentAddresses({ result: [
      { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4' }] },
      { name: 'eth0', 'ip-addresses': [{ 'ip-address': 'fe80::1', 'ip-address-type': 'ipv6' }, { 'ip-address': '2001:db8::5', 'ip-address-type': 'ipv6' }, { 'ip-address': '10.0.0.5', 'ip-address-type': 'ipv4' }] },
    ] })).toEqual(['10.0.0.5', '2001:db8::5'])
    expect(parseLxcInterfaces([{ name: 'lo', inet: '127.0.0.1/8' }, { name: 'eth0', inet: '192.168.1.20/24', inet6: 'fe80::2/64' }])).toEqual(['192.168.1.20'])
  })

  it('empreintes de certificat', () => {
    expect(normalizeFingerprint('ab:cd:EF:01')).toBe('ABCDEF01')
    expect(formatFingerprint('abcdef01')).toBe('AB:CD:EF:01')
    expect(fingerprintsMatch('AB:CD', 'abcd')).toBe(true)
    expect(fingerprintsMatch(null, 'abcd')).toBe(false)
    expect(fingerprintsMatch('AB:CE', 'abcd')).toBe(false)
  })
})
