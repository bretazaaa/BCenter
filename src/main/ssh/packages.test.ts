import { describe, expect, it } from 'vitest'
import { normalizeSshFingerprint, sshFingerprint } from './client'
import { commands, parseApk, parseApt, parseDnf, parseDnfSecurity, parsePackageManager, parsePacman, parseZypper } from './packages'

describe('analyse des gestionnaires de paquets', () => {
  it('apt : versions et dépôt de sécurité', () => {
    const packages = parseApt(`Listing...
nginx/bookworm-security 1.22.1-9+deb12u1 amd64 [upgradable from: 1.22.1-9]
curl/stable 7.88.1-10+deb12u8 amd64 [upgradable from: 7.88.1-10+deb12u7]`)
    expect(packages).toHaveLength(2)
    expect(packages[0]).toMatchObject({ name: 'nginx', newVersion: '1.22.1-9+deb12u1', currentVersion: '1.22.1-9', security: true })
    expect(packages[1].security).toBe(false)
  })

  it('dnf : s’arrête aux paquets obsolètes et applique la liste de sécurité', () => {
    const security = parseDnfSecurity('RHSA-2024:1 Important/Sec. openssl-1:3.0.7-27.el9.x86_64')
    const packages = parseDnf(`
kernel.x86_64          5.14.0-427.el9     baseos
openssl.x86_64         1:3.0.7-27.el9     baseos
Obsoleting Packages
grub2-tools.x86_64     1:2.06-77.el9      baseos`, security)
    expect(packages.map((p) => p.name)).toEqual(['kernel', 'openssl'])
    expect(packages[1].security).toBe(true)
    expect(packages[0].security).toBe(false)
  })

  it('apk, pacman et zypper', () => {
    expect(parseApk('musl-1.2.4-r2 < 1.2.4-r3\nca-certificates-bundle-20230506-r0 < 20240226-r0')).toEqual([
      { name: 'musl', currentVersion: '1.2.4-r2', newVersion: '1.2.4-r3', security: false },
      { name: 'ca-certificates-bundle', currentVersion: '20230506-r0', newVersion: '20240226-r0', security: false },
    ])
    expect(parsePacman('linux 6.6.1.arch1-1 -> 6.6.2.arch1-1')[0].name).toBe('linux')
    const zypper = parseZypper(`S | Repository | Name    | Current Version | Available Version | Arch
--+------------+---------+-----------------+-------------------+-------
v | repo-oss   | openssl | 3.1.4-1.1       | 3.1.4-2.1         | x86_64`)
    expect(zypper).toEqual([{ repository: 'repo-oss', name: 'openssl', currentVersion: '3.1.4-1.1', newVersion: '3.1.4-2.1', security: false }])
  })

  it('détection et commandes non interactives', () => {
    expect(parsePackageManager('apt\n')).toBe('apt')
    expect(parsePackageManager('rien')).toBe('unknown')
    const upgrade = commands.upgrade('apt', true)
    expect(upgrade).toContain('DEBIAN_FRONTEND=noninteractive')
    expect(upgrade.endsWith('full-upgrade')).toBe(true)
  })

  it('empreintes SSH au format OpenSSH', () => {
    expect(normalizeSshFingerprint('SHA256:ohD8VZEXGWo6Ez8GSEJQ9WpafgLFsOfLOtGGQCQo6Og')).toBe('ohD8VZEXGWo6Ez8GSEJQ9WpafgLFsOfLOtGGQCQo6Og')
    expect(sshFingerprint(Buffer.from('cle'))).not.toContain('=')
  })
})
