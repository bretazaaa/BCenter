import type { PackageManager, PackageUpdate } from '@shared/types'

/** Commandes non interactives par gestionnaire de paquets. */
export const commands = {
  detect:
    'if command -v apt-get >/dev/null 2>&1; then echo apt; elif command -v dnf >/dev/null 2>&1; then echo dnf; ' +
    'elif command -v yum >/dev/null 2>&1; then echo yum; elif command -v apk >/dev/null 2>&1; then echo apk; ' +
    'elif command -v zypper >/dev/null 2>&1; then echo zypper; elif command -v pacman >/dev/null 2>&1; then echo pacman; else echo unknown; fi',

  systemInfo:
    'echo "host=$(hostname)"; echo "kernel=$(uname -r)"; echo "uid=$(id -u)"; ' +
    'if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$NAME"; echo "version=$VERSION_ID"; fi',

  rebootRequired:
    'if [ -f /var/run/reboot-required ]; then echo yes; ' +
    'elif command -v needs-restarting >/dev/null 2>&1; then needs-restarting -r >/dev/null 2>&1 || echo yes; else echo no; fi',

  /** Redémarrage différé pour que la commande SSH se termine proprement. */
  reboot: `sh -c 'nohup sh -c "sleep 2; systemctl reboot || reboot" >/dev/null 2>&1 &'`,

  refresh(pm: PackageManager): string | null {
    return { apt: 'apt-get update -q', apk: 'apk update -q', zypper: 'zypper --non-interactive -q refresh' }[pm as 'apt'] ?? null
  },

  listUpdates(pm: PackageManager): string {
    switch (pm) {
      case 'apt': return 'apt list --upgradable 2>/dev/null'
      case 'dnf': return 'dnf -q check-update; true'
      case 'yum': return 'yum -q check-update; true'
      case 'apk': return "apk version -l '<'"
      case 'zypper': return 'zypper --non-interactive -q list-updates'
      case 'pacman': return 'if command -v checkupdates >/dev/null 2>&1; then checkupdates; true; else pacman -Qu; true; fi'
      default: throw new Error('Gestionnaire de paquets non pris en charge.')
    }
  },

  listSecurity(pm: PackageManager): string | null {
    if (pm === 'dnf') return 'dnf -q updateinfo list --security 2>/dev/null; true'
    if (pm === 'yum') return 'yum -q updateinfo list security 2>/dev/null; true'
    return null
  },

  upgrade(pm: PackageManager, full: boolean): string {
    switch (pm) {
      case 'apt':
        return (
          'env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get -y -q ' +
          '-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold ' +
          (full ? 'full-upgrade' : 'upgrade')
        )
      case 'dnf': return full ? 'dnf -y distro-sync' : 'dnf -y upgrade'
      case 'yum': return 'yum -y update'
      case 'apk': return 'apk upgrade --no-progress' + (full ? ' --available' : '')
      case 'zypper': return full ? 'zypper --non-interactive dist-upgrade' : 'zypper --non-interactive update'
      case 'pacman': return 'pacman -Syu --noconfirm'
      default: throw new Error('Gestionnaire de paquets non pris en charge.')
    }
  },
}

export function parsePackageManager(output: string): PackageManager {
  const v = output.trim()
  return (['apt', 'dnf', 'yum', 'apk', 'zypper', 'pacman'] as const).find((p) => p === v) ?? 'unknown'
}

const lines = (output: string) => output.split('\n').map((l) => l.trim()).filter(Boolean)

// nginx/bookworm-security 1.22.1-9+deb12u1 amd64 [upgradable from: 1.22.1-9]
export function parseApt(output: string): PackageUpdate[] {
  const re = /^([^/\s]+)\/(\S+)\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]]+)\])?/
  return lines(output).flatMap((l) => {
    const m = re.exec(l)
    return m ? [{ name: m[1], repository: m[2], newVersion: m[3], currentVersion: m[4], security: /security/i.test(m[2]) }] : []
  })
}

// kernel.x86_64    5.14.0-427.el9    baseos
export function parseDnf(output: string, security?: Set<string>): PackageUpdate[] {
  const result: PackageUpdate[] = []
  for (const l of lines(output)) {
    if (l.startsWith('Obsoleting') || l.startsWith('Last metadata')) break
    const parts = l.split(/\s+/)
    if (parts.length !== 3 || !parts[0].includes('.')) continue
    const name = parts[0].slice(0, parts[0].lastIndexOf('.'))
    result.push({ name, newVersion: parts[1], repository: parts[2], security: !!security && (security.has(name) || security.has(parts[0])) })
  }
  return result
}

/** Noms de paquets de « dnf updateinfo list --security » (ex. « RHSA-2024:1 Important/Sec. openssl-3.0.7-1.el9.x86_64 »). */
export function parseDnfSecurity(output: string): Set<string> {
  const set = new Set<string>()
  for (const l of lines(output)) {
    const parts = l.split(/\s+/)
    if (parts.length < 3) continue
    const m = /^(.+?)-\d[^-]*-[^-]+\.[^.]+$/.exec(parts[parts.length - 1])
    if (m) set.add(m[1])
  }
  return set
}

// musl-1.2.4-r2 < 1.2.4-r3
export function parseApk(output: string): PackageUpdate[] {
  return lines(output).flatMap((l) => {
    const m = /^(.+?)-(\d\S*-r\d+)\s+<\s+(\S+)/.exec(l)
    return m ? [{ name: m[1], currentVersion: m[2], newVersion: m[3], security: false }] : []
  })
}

// v | repo-oss | openssl | 3.1.4-1.1 | 3.1.4-2.1 | x86_64
export function parseZypper(output: string): PackageUpdate[] {
  return lines(output)
    .map((l) => l.split('|').map((p) => p.trim()))
    .filter((p) => p.length >= 6 && p[0] === 'v')
    .map((p) => ({ repository: p[1], name: p[2], currentVersion: p[3], newVersion: p[4], security: false }))
}

// linux 6.6.1.arch1-1 -> 6.6.2.arch1-1
export function parsePacman(output: string): PackageUpdate[] {
  return lines(output).flatMap((l) => {
    const m = /^(\S+)\s+(\S+)\s+->\s+(\S+)/.exec(l)
    return m ? [{ name: m[1], currentVersion: m[2], newVersion: m[3], security: false }] : []
  })
}

export function parseUpdates(pm: PackageManager, output: string, security?: Set<string>): PackageUpdate[] {
  switch (pm) {
    case 'apt': return parseApt(output)
    case 'dnf':
    case 'yum': return parseDnf(output, security)
    case 'apk': return parseApk(output)
    case 'zypper': return parseZypper(output)
    case 'pacman': return parsePacman(output)
    default: return []
  }
}
