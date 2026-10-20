import { createHash, createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fromPutty, fromWinScp, knownHostFingerprints, parseMobaXterm, parseRegQuery, parseSshConfig, readXpipe } from './importers'

describe('import de connexions', () => {
  it('OpenSSH : alias, valeurs par défaut de Host *, motifs ignorés', () => {
    const found = parseSshConfig(
      `Host web
  HostName 10.0.0.21
  User deploy
Host nas backup
  HostName %h.lan
  Port 2222
Host *.internal !skip
  User ops
Match host foo
  User nope
Host *
  User root
  IdentityFile ~/.ssh/id_ed25519`,
      'C:\\Users\\me',
    )
    expect(found.map((f) => [f.name, f.host, f.port, f.username, f.keyPath])).toEqual([
      ['web', '10.0.0.21', 22, 'deploy', 'C:\\Users\\me/.ssh/id_ed25519'],
      ['nas', 'nas.lan', 2222, 'root', 'C:\\Users\\me/.ssh/id_ed25519'],
      ['backup', 'backup.lan', 2222, 'root', 'C:\\Users\\me/.ssh/id_ed25519'],
    ])
  })

  it('XPipe : connexions SSH, utilisateur, catégorie ; scripts et secrets ignorés', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xpipe-'))
    const write = (path: string, data: object) => {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), JSON.stringify(data))
    }
    write('categories/root/category.json', { uuid: 'root', name: 'All connections', parentUuid: null })
    write('categories/def/category.json', { uuid: 'def', name: 'Default', parentUuid: 'root' })
    write('categories/lab/category.json', { uuid: 'lab', name: 'Homelab', parentUuid: 'root' })
    write('stores/a/entry.json', { uuid: 'a', name: 'pve01', categoryUuid: 'lab' })
    write('stores/a/store.json', {
      type: 'ssh', host: '10.0.0.10', port: 22,
      identity: { type: 'inPlace', identityStore: { type: 'localIdentity', username: 'root', password: { secrets: [{ secret: 'x' }] }, sshIdentity: { secrets: [] } } },
    })
    write('stores/b/entry.json', { uuid: 'b', name: 'nas', categoryUuid: 'def' })
    write('stores/b/store.json', { type: 'ssh', host: 'nas.lan', port: 2200, identity: { type: 'inPlace', identityStore: { username: 'admin', sshIdentity: { type: 'file', file: 'C:\\keys\\nas' } } } })
    write('stores/c/entry.json', { uuid: 'c', name: 'script', categoryUuid: 'lab' })
    write('stores/c/store.json', { type: 'script', textSource: { text: 'echo' } })
    try {
      const found = readXpipe(dir).sort((x, y) => x.name.localeCompare(y.name))
      expect(found).toEqual([
        { source: 'xpipe', name: 'nas', host: 'nas.lan', port: 2200, username: 'admin', keyPath: 'C:\\keys\\nas', group: null },
        { source: 'xpipe', name: 'pve01', host: '10.0.0.10', port: 22, username: 'root', keyPath: null, group: 'Homelab' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PuTTY et WinSCP (registre), MobaXterm (ini)', () => {
    const root = 'HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions'
    const putty = parseRegQuery(`
${root}\\Mon%20serveur
    HostName    REG_SZ    admin@srv.lan
    PortNumber    REG_DWORD    0x16
    Protocol    REG_SZ    ssh

${root}\\Telnet
    HostName    REG_SZ    old.lan
    Protocol    REG_SZ    telnet
`, root)
    expect(fromPutty(putty)).toEqual([{ source: 'putty', name: 'Mon serveur', host: 'srv.lan', port: 22, username: 'admin', keyPath: null, group: null }])

    const wroot = 'HKEY_CURRENT_USER\\Software\\Martin Prikryl\\WinSCP 2\\Sessions'
    const winscp = parseRegQuery(`
${wroot}\\Prod/web%20front
    HostName    REG_SZ    10.0.0.21
    PortNumber    REG_DWORD    0x8ae
    UserName    REG_SZ    deploy
${wroot}\\ftp
    HostName    REG_SZ    ftp.lan
    FSProtocol    REG_DWORD    0x5
`, wroot)
    expect(fromWinScp(winscp)).toEqual([{ source: 'winscp', name: 'web front', host: '10.0.0.21', port: 2222, username: 'deploy', keyPath: null, group: 'Prod' }])

    expect(parseMobaXterm(`[Bookmarks]
SubRep=
ImgNum=42
pve= #109#0%192.168.1.10%22%root%%-1%-1%%%22%%0%0%0%%%-1%0%0%0%%1080%%0%0%1#MobaFont%10
rdp= #91#4%win.lan%3389%admin
[Bookmarks_1]
SubRep=Lab\\Réseau
ImgNum=41
dns= #109#0%dns.lan%2222%%
`)).toEqual([
      { source: 'mobaxterm', name: 'pve', host: '192.168.1.10', port: 22, username: 'root', keyPath: null, group: null },
      { source: 'mobaxterm', name: 'dns', host: 'dns.lan', port: 2222, username: null, keyPath: null, group: 'Lab/Réseau' },
    ])
  })

  it('known_hosts : hôtes en clair, avec port et hachés', () => {
    const key = Buffer.from('fake-host-key').toString('base64')
    const fingerprint = createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '')
    const salt = Buffer.from('0123456789abcdef0123')
    const hashed = `|1|${salt.toString('base64')}|${createHmac('sha1', salt).update('secret.lan').digest('base64')}`
    const text = `web.lan,10.0.0.21 ssh-ed25519 ${key}\n[nas.lan]:2222 ssh-ed25519 ${key}\n${hashed} ssh-ed25519 ${key}\n# commentaire`
    expect(knownHostFingerprints(text, '10.0.0.21', 22)).toEqual([fingerprint])
    expect(knownHostFingerprints(text, 'nas.lan', 2222)).toEqual([fingerprint])
    expect(knownHostFingerprints(text, 'nas.lan', 22)).toEqual([])
    expect(knownHostFingerprints(text, 'secret.lan', 22)).toEqual([fingerprint])
  })
})
