import { execFile } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ImportCandidate, ImportSource, ImportSourceStatus } from '@shared/types'

/** Connexion lue dans un gestionnaire, avant déduplication. */
export type Found = Omit<ImportCandidate, 'id' | 'existingTargetId'>

type Row = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const portOf = (v: unknown) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 22
}
const expandHome = (path: string, home: string) => path.replace(/^~(?=[\\/]|$)/, home).replace(/^"(.*)"$/, '$1')

// ------------------------------------------------------------------ OpenSSH (~/.ssh/config)

const glob = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i').test(value)

/**
 * Hôtes déclarés dans un fichier de configuration OpenSSH. Comme ssh, la première valeur trouvée parmi
 * les blocs « Host » correspondants l'emporte (les valeurs par défaut de « Host * » s'appliquent donc).
 */
export function parseSshConfig(text: string, home: string): Found[] {
  const blocks: { patterns: string[]; options: Map<string, string> }[] = []
  let current: (typeof blocks)[number] | null = { patterns: ['*'], options: new Map() }
  blocks.push(current)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'host') {
      current = { patterns: value.split(/\s+/).map((p) => p.replace(/^"|"$/g, '')), options: new Map() }
      blocks.push(current)
    } else if (key === 'match') {
      current = null // Blocs conditionnels non pris en charge.
    } else if (current && !current.options.has(key)) {
      current.options.set(key, value)
    }
  }
  const aliases = [...new Set(blocks.flatMap((b) => b.patterns).filter((p) => !/[*?!]/.test(p)))]
  return aliases.map((alias) => {
    const get = (key: string) => {
      for (const b of blocks) {
        if (b.patterns.some((p) => !p.startsWith('!') && glob(p, alias)) && !b.patterns.some((p) => p.startsWith('!') && glob(p.slice(1), alias))) {
          const v = b.options.get(key)
          if (v) return v
        }
      }
      return undefined
    }
    const identity = get('identityfile')
    return {
      source: 'ssh-config' as const,
      name: alias,
      host: get('hostname')?.replace(/%h/g, alias) ?? alias,
      port: portOf(get('port')),
      username: get('user') ?? null,
      keyPath: identity && identity.toLowerCase() !== 'none' ? expandHome(identity, home) : null,
      group: null,
    }
  })
}

// ------------------------------------------------------------------ XPipe

function readJson(path: string): Row | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Row
  } catch {
    return null
  }
}

/** Premier champ texte portant l'un de ces noms, à n'importe quelle profondeur. */
function findString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null
  for (const [k, v] of Object.entries(value as Row)) {
    if (keys.includes(k) && typeof v === 'string' && v.trim()) return v.trim()
  }
  for (const v of Object.values(value as Row)) {
    const found = findString(v, keys)
    if (found) return found
  }
  return null
}

/**
 * Connexions SSH du stockage XPipe (~/.xpipe/storage). Les secrets restent dans le coffre chiffré de XPipe :
 * seuls le nom, l'adresse, le port, l'utilisateur, la clé (fichier) et la catégorie sont repris.
 */
export function readXpipe(storage: string): Found[] {
  const categories = new Map<string, Row>()
  const categoryDir = join(storage, 'categories')
  if (existsSync(categoryDir)) {
    for (const id of readdirSync(categoryDir)) {
      const c = readJson(join(categoryDir, id, 'category.json'))
      if (c) categories.set(id, c)
    }
  }
  const storesDir = join(storage, 'stores')
  const stores = new Map<string, { entry: Row; store: Row }>()
  for (const id of existsSync(storesDir) ? readdirSync(storesDir) : []) {
    const entry = readJson(join(storesDir, id, 'entry.json'))
    const store = readJson(join(storesDir, id, 'store.json'))
    if (entry && store) stores.set(id, { entry, store })
  }

  const groupOf = (categoryId: unknown) => {
    const c = typeof categoryId === 'string' ? categories.get(categoryId) : undefined
    const name = str(c?.name)
    // Catégories racines (« All connections »…) et catégorie par défaut : pas de dossier.
    if (!c || !c.parentUuid || !name || name.toLowerCase() === 'default') return null
    return name
  }

  const found: Found[] = []
  for (const { entry, store } of stores.values()) {
    if (store.type !== 'ssh') continue
    const host = str(store.host)
    if (!host) continue
    const identity = (store.identity ?? {}) as Row
    // Identité partagée : référence vers une autre entrée du stockage.
    const refId = findString(identity, ['storeId', 'ref', 'uuid'])
    const shared = refId ? stores.get(refId)?.store : undefined
    const username = findString(identity, ['username', 'user']) ?? (shared ? findString(shared, ['username', 'user']) : null)
    const keySource = (identity as Row).identityStore ?? shared ?? identity
    const sshIdentity = (keySource as Row)?.sshIdentity
    const keyPath = sshIdentity && typeof sshIdentity === 'object' && !('secrets' in (sshIdentity as Row)) ? findString(sshIdentity, ['file', 'path', 'location']) : null
    found.push({ source: 'xpipe', name: str(entry.name) ?? host, host, port: portOf(store.port), username, keyPath, group: groupOf(entry.categoryUuid) })
  }
  return found
}

// ------------------------------------------------------------------ PuTTY et WinSCP (registre Windows)

/** Analyse la sortie de `reg query <clé> /s` : une entrée par sous-clé, avec ses valeurs. */
export function parseRegQuery(output: string, root: string): { key: string; values: Record<string, string> }[] {
  const result: { key: string; values: Record<string, string> }[] = []
  let current: (typeof result)[number] | null = null
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      const key = line.trim().slice(root.length).replace(/^\\/, '')
      current = key ? { key, values: {} } : null
      if (current) result.push(current)
      continue
    }
    const m = /^\s{2,}(.+?)\s{2,}(REG_\w+)\s{2,}(.*)$/.exec(line)
    if (m && current) current.values[m[1]] = m[2] === 'REG_DWORD' ? String(Number.parseInt(m[3], 16)) : m[3]
  }
  return result
}

const decode = (name: string) => {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function splitUserHost(value: string, user: string | null): { host: string; username: string | null } {
  const at = value.lastIndexOf('@')
  return at > 0 ? { host: value.slice(at + 1), username: user ?? value.slice(0, at) } : { host: value, username: user }
}

export function fromPutty(entries: { key: string; values: Record<string, string> }[]): Found[] {
  return entries
    .filter((e) => (e.values.Protocol ?? 'ssh') === 'ssh' && str(e.values.HostName))
    .map((e) => {
      const { host, username } = splitUserHost(e.values.HostName.trim(), str(e.values.UserName))
      return { source: 'putty' as const, name: decode(e.key), host, port: portOf(Number(e.values.PortNumber) || 22), username, keyPath: str(e.values.PublicKeyFile), group: null }
    })
}

export function fromWinScp(entries: { key: string; values: Record<string, string> }[]): Found[] {
  // FSProtocol : 5 FTP, 6 WebDAV, 7 S3 (non SSH).
  return entries
    .filter((e) => str(e.values.HostName) && !['5', '6', '7'].includes(e.values.FSProtocol ?? '') && !e.key.startsWith('Default%20Settings'))
    .map((e) => {
      const path = decode(e.key)
      const slash = path.lastIndexOf('/')
      return {
        source: 'winscp' as const, name: slash >= 0 ? path.slice(slash + 1) : path, host: e.values.HostName.trim(),
        port: portOf(Number(e.values.PortNumber) || 22), username: str(e.values.UserName), keyPath: str(e.values.PublicKeyFile),
        group: slash > 0 ? path.slice(0, slash) : null,
      }
    })
}

// ------------------------------------------------------------------ MobaXterm

/** Signets SSH de MobaXterm.ini (sections [Bookmarks…], type 109 = SSH). */
export function parseMobaXterm(text: string): Found[] {
  const found: Found[] = []
  let inBookmarks = false
  let folder: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const section = /^\[(.+)\]$/.exec(line)
    if (section) {
      inBookmarks = /^Bookmarks(_\d+)?$/i.test(section[1])
      folder = null
      continue
    }
    if (!inBookmarks) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1).trim()
    if (key === 'SubRep') folder = value.replace(/\\/g, '/').trim() || null
    if (key === 'ImgNum' || key === 'SubRep') continue
    const fields = value.split('%')
    if (!/^#109#/.test(fields[0] ?? '') || !fields[1]) continue
    found.push({ source: 'mobaxterm', name: key.trim(), host: fields[1].trim(), port: portOf(Number(fields[2]) || 22), username: str(fields[3]), keyPath: null, group: folder })
  }
  return found
}

// ------------------------------------------------------------------ known_hosts

/** Empreinte SHA-256 (format OpenSSH) des clés connues pour cet hôte dans un fichier known_hosts. */
export function knownHostFingerprints(text: string, host: string, port: number): string[] {
  const names = port === 22 ? [host] : [`[${host}]:${port}`]
  const fingerprints: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 3 || parts[0].startsWith('#')) continue
    if (parts[0].startsWith('@')) parts.shift() // @cert-authority / @revoked
    const [patterns, , key] = parts
    const matches = patterns.split(',').some((p) => {
      if (p.startsWith('|1|')) {
        const [, , salt, hash] = p.split('|')
        return names.some((n) => createHmac('sha1', Buffer.from(salt, 'base64')).update(n).digest('base64') === hash)
      }
      return !p.startsWith('!') && names.some((n) => glob(p, n))
    })
    if (matches && key) fingerprints.push(createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, ''))
  }
  return fingerprints
}

// ------------------------------------------------------------------ Découverte

const exec = promisify(execFile)

async function regQuery(root: string) {
  try {
    // Chemin absolu : un « reg.exe » placé dans le dossier courant ne doit jamais être exécuté.
    const reg = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    const { stdout } = await exec(reg, ['query', root, '/s'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    return parseRegQuery(stdout, root)
  } catch {
    return null // Clé absente : logiciel non installé.
  }
}

/** Recherche les connexions SSH des gestionnaires installés sur ce PC. */
export async function discover(home = homedir(), appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')): Promise<{ sources: ImportSourceStatus[]; found: Found[] }> {
  const sources: ImportSourceStatus[] = []
  const found: Found[] = []
  const add = (source: ImportSource, location: string | undefined, read: () => Found[] | null) => {
    try {
      const items = read()
      sources.push({ source, found: items !== null, count: items?.length ?? 0, location })
      if (items) found.push(...items)
    } catch (error) {
      sources.push({ source, found: true, count: 0, location, error: (error as Error).message })
    }
  }

  const xpipe = [join(home, '.xpipe', 'storage'), join(home, '.xpipe-ptb', 'storage')].find((p) => existsSync(p))
  add('xpipe', xpipe, () => (xpipe ? readXpipe(xpipe) : null))
  const sshConfig = join(home, '.ssh', 'config')
  add('ssh-config', sshConfig, () => (existsSync(sshConfig) ? parseSshConfig(readFileSync(sshConfig, 'utf8'), home) : null))

  const putty = await regQuery('HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions')
  add('putty', 'Registre Windows', () => (putty ? fromPutty(putty) : null))
  const winscp = await regQuery('HKEY_CURRENT_USER\\Software\\Martin Prikryl\\WinSCP 2\\Sessions')
  add('winscp', 'Registre Windows', () => (winscp ? fromWinScp(winscp) : null))

  const moba = [join(appData, 'MobaXterm', 'MobaXterm.ini'), join(home, 'Documents', 'MobaXterm', 'MobaXterm.ini')].find((p) => existsSync(p))
  add('mobaxterm', moba, () => (moba ? parseMobaXterm(readFileSync(moba, 'utf8')) : null))

  return { sources, found }
}
