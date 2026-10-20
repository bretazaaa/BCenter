import { readFileSync, existsSync, mkdirSync, statSync, createReadStream } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import { extname, join, resolve, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BCenterApi, BCenterEvents } from '@shared/api'
import { createDemoPorts, seedDemo } from '../main/demo'
import { Engine, type EnginePorts } from '../main/engine'
import { AuthError, AuthService } from './auth'
import { serverCipher } from './crypto'

/**
 * BCenter Server : le moteur de BCenter et son interface servis dans le navigateur (client léger).
 * Configuration par variables d'environnement, données dans BCENTER_DATA_DIR (volume Docker /data).
 */
const env = process.env
const dataDir = resolve(env.BCENTER_DATA_DIR ?? './data')
const port = Number(env.PORT ?? 8080)
const host = env.HOST ?? '0.0.0.0'
const demo = env.BCENTER_DEMO === '1'
/** Derrière un reverse proxy (Traefik, Caddy, Nginx…) : X-Forwarded-For / X-Forwarded-Proto sont pris en compte. */
const trustProxy = env.BCENTER_TRUST_PROXY === '1'
const webDir = resolve(env.BCENTER_WEB_DIR ?? join(import.meta.dirname, '../web'))
const version = (JSON.parse(readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8')) as { version: string }).version

mkdirSync(dataDir, { recursive: true })
const sockets = new Set<WebSocket>()

const ports: EnginePorts = {
  dataDir,
  cipher: serverCipher(join(dataDir, 'secret.key'), env.BCENTER_SECRET_KEY),
  // Notifications : journalisées (webhooks Discord / ntfy à venir).
  notify: (title, body, severity) => engine.logger.scope('Alertes').warn(`[${severity}] ${title} — ${body}`),
  broadcast: <K extends keyof BCenterEvents>(event: K, payload: BCenterEvents[K]) => {
    const message = JSON.stringify({ event, payload })
    for (const ws of sockets) if (ws.readyState === ws.OPEN) ws.send(message)
  },
}
const engine = new Engine(demo ? createDemoPorts(ports) : ports)
engine.settings.load()
if (demo) seedDemo(engine)
if (!engine.secrets.selfTest()) throw new Error('Chiffrement des secrets indisponible.')
engine.monitor.reloadServers()
engine.start()
const log = engine.logger.scope('Serveur')
const auth = new AuthService(engine.db, engine.secrets)

// ------------------------------------------------------------------ Opérations propres au serveur

const notInWeb = (what: string) => async () => {
  throw new Error(`${what} n’est pas encore disponible dans la version web.`)
}

/** Équivalents web des opérations de la fenêtre Electron. */
const host_: Partial<BCenterApi> = {
  windowMinimize: async () => undefined,
  windowToggleMaximize: async () => undefined,
  windowClose: async () => undefined,
  appInfo: async () => ({ version, dataDir, logsDir: join(dataDir, 'logs') }),
  openPath: notInWeb('L’ouverture de dossiers'),
  pickPrivateKey: async () => null,
  quit: notInWeb('Quitter'),
  checkAppUpdate: async () => ({ state: 'none' as const }),
  installAppUpdate: notInWeb('La mise à jour depuis l’interface (mettez à jour l’image Docker)'),
  saveSettings: async (settings) => {
    const saved = engine.settings.save(settings)
    void engine.monitor.refresh()
    return saved
  },
  fsDownload: notInWeb('Le téléchargement de fichiers'),
  fsUpload: notInWeb('L’envoi de fichiers'),
  openDetached: async () => undefined,
  reattach: async () => undefined,
}
/** Opérations du moteur qui liraient des fichiers du serveur lui-même : refusées dans la version web. */
const BLOCKED = new Set<string>(['fsUploadPaths'])

// ------------------------------------------------------------------ HTTP

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json',
}

const clientIp = (req: IncomingMessage) =>
  (trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?'
const isHttps = (req: IncomingMessage) => (req.socket as { encrypted?: boolean }).encrypted === true || (trustProxy && req.headers['x-forwarded-proto'] === 'https')

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return undefined
}

function sessionCookie(req: IncomingMessage, token: string, maxAge: number) {
  return `bcenter_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`
}

/** Requête provenant de la même origine (protection contre les requêtes intersites). */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === (trustProxy ? String(req.headers['x-forwarded-host'] ?? req.headers.host) : req.headers.host)
  } catch {
    return false
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}), ...headers })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, string>> {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        // On cesse de lire : la réponse 413 est envoyée puis la connexion fermée.
        req.pause()
        req.removeAllListeners('data')
        reject(new AuthError(413, 'Requête trop volumineuse.'))
      } else chunks.push(c)
    })
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
        resolveBody(value && typeof value === 'object' ? (value as Record<string, string>) : {})
      } catch {
        reject(new AuthError(400, 'JSON invalide.'))
      }
    })
    req.on('error', reject)
  })
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function handleAuth(req: IncomingMessage, res: ServerResponse, path: string) {
  const ip = clientIp(req)
  if (path === '/api/auth/state' && req.method === 'GET') {
    const s = auth.session(cookie(req, 'bcenter_session'))
    return send(res, 200, { configured: !!auth.admin, authenticated: !!s, username: s?.username ?? null, https: isHttps(req), version })
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'Méthode non autorisée.' })
  if (!sameOrigin(req)) return send(res, 403, { error: 'Origine refusée.' })
  const body = await readJson(req)
  if (path === '/api/auth/setup/start') return send(res, 200, await auth.startSetup(ip, str(body.setupCode)))
  if (path === '/api/auth/setup/finish') {
    const token = await auth.finishSetup(ip, { setupCode: str(body.setupCode), username: str(body.username), password: str(body.password), code: str(body.code) })
    log.info(`Compte administrateur créé depuis ${ip}`)
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, 7 * 86_400) })
  }
  if (path === '/api/auth/login') {
    try {
      const token = await auth.login(ip, { username: str(body.username), password: str(body.password), code: str(body.code) })
      log.info(`Connexion à l’interface web depuis ${ip}`)
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token, 7 * 86_400) })
    } catch (error) {
      log.warn(`Échec de connexion depuis ${ip}`)
      throw error
    }
  }
  if (path === '/api/auth/logout') {
    auth.logout(cookie(req, 'bcenter_session'))
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) })
  }
  return send(res, 404, { error: 'Introuvable.' })
}

function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  // Chemin normalisé et confiné au dossier de l'interface.
  let file = resolve(webDir, `.${decodeURIComponent(path)}`)
  if (file !== webDir && !file.startsWith(webDir + sep)) return send(res, 403, { error: 'Interdit.' })
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(webDir, 'index.html')
  if (!existsSync(file)) return send(res, 500, { error: 'Interface web introuvable : lancez npm run server:build.' })
  const immutable = file.includes(`${sep}assets${sep}`)
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  try {
    if (path === '/healthz') return send(res, 200, { ok: true })
    if (path.startsWith('/api/auth/')) return await handleAuth(req, res, path)
    if (path.startsWith('/api/')) return send(res, 404, { error: 'Introuvable.' })
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Méthode non autorisée.' })
    serveStatic(req, res, path)
  } catch (error) {
    const status = error instanceof AuthError ? error.status : 500
    if (status === 500) log.error('Erreur HTTP', error)
    send(res, status, { error: error instanceof Error && status !== 500 ? error.message : 'Erreur interne.' })
  }
}

// ------------------------------------------------------------------ WebSocket (appels du moteur et événements)

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 })

/** Onglet propriétaire de chaque session SSH / SFTP : elle est fermée avec lui (reprise possible par un autre onglet). */
const owners = new Map<string, { ws: WebSocket; kind: 'shell' | 'files' }>()

wss.on('connection', (ws: WebSocket, token: string) => {
  sockets.add(ws)
  const owned = {
    set: (id: string, kind: 'shell' | 'files') => owners.set(id, { ws, kind }),
    delete: (id: string) => owners.delete(id),
  }
  ws.on('message', async (raw) => {
    let msg: { id?: number; name?: string; args?: unknown[] }
    try {
      msg = JSON.parse(String(raw)) as typeof msg
    } catch {
      return
    }
    if (typeof msg.id !== 'number' || typeof msg.name !== 'string' || !Array.isArray(msg.args)) return
    // Session révoquée ou expirée : déconnexion immédiate.
    if (!auth.session(token)) return ws.close(4401, 'Session expirée')
    const name = msg.name
    try {
      // Propriétés propres uniquement : « constructor », « toString »… ne sont pas des opérations.
      const handler = (Object.hasOwn(host_, name) ? host_[name as keyof typeof host_] : !BLOCKED.has(name) && Object.hasOwn(engine.api, name) ? engine.api[name as keyof Engine['api']] : undefined) as
        | ((...a: unknown[]) => Promise<unknown>)
        | undefined
      if (!handler) throw new Error(`Opération inconnue ou indisponible : ${name}`)
      const value = await handler(...msg.args)
      if (name === 'openShell') owned.set(value as string, 'shell')
      if (name === 'shellAttach') owned.set(msg.args[0] as string, 'shell')
      if (name === 'fsOpen') owned.set((value as { id: string }).id, 'files')
      if (name === 'shellClose' || name === 'fsClose') owned.delete(msg.args[0] as string)
      ws.send(JSON.stringify({ id: msg.id, ok: true, value: value ?? null }))
    } catch (error) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: error instanceof Error ? error.message : String(error) }))
    }
  })
  ws.on('close', () => {
    sockets.delete(ws)
    for (const [id, o] of [...owners]) {
      if (o.ws !== ws) continue
      owners.delete(id)
      void (o.kind === 'shell' ? engine.api.shellClose(id) : engine.api.fsClose(id))
    }
  })
})

const server = env.BCENTER_TLS_CERT && env.BCENTER_TLS_KEY
  ? https.createServer({ cert: readFileSync(env.BCENTER_TLS_CERT), key: readFileSync(env.BCENTER_TLS_KEY) }, (req, res) => void handle(req, res))
  : http.createServer((req, res) => void handle(req, res))

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  const token = cookie(req, 'bcenter_session')
  // Même origine obligatoire : une page tierce ne peut pas utiliser la session de l'utilisateur.
  if (path !== '/ws' || !sameOrigin(req) || !auth.session(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, token))
})

server.listen(port, host, () => {
  log.info(`BCenter Server ${version}${demo ? ' (démonstration)' : ''} à l’écoute sur ${host}:${port}`)
  if (auth.setupCode) {
    console.log(`\n  Première connexion : ouvrez l’interface et saisissez le code d’installation  ${auth.setupCode}\n`)
  }
  if (!env.BCENTER_TLS_CERT && !trustProxy) {
    console.log('  Conseil : placez BCenter derrière un reverse proxy HTTPS ou un VPN (Tailscale, WireGuard), sans exposition directe sur Internet.\n')
  }
})

const shutdown = () => {
  log.info('Arrêt du serveur')
  engine.stop()
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
