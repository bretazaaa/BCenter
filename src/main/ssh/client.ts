import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import { Client, type ConnectConfig } from 'ssh2'
import type { HostKeyInfo, JobLogLine, LogLevel, RemoteSystem, ScanResult, SshCredential, SshTarget, UpgradeOptions } from '@shared/types'
import { commands, parseDnfSecurity, parsePackageManager, parseUpdates } from './packages'

export interface SshSecrets {
  password?: string | null
  passphrase?: string | null
}

export type LogSink = (line: JobLogLine) => void

/** Opérations de maintenance exécutées sur une machine distante. */
export interface RemoteMaintenance {
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>
  testConnection(target: SshTarget, credential: SshCredential, secrets: SshSecrets): Promise<RemoteSystem>
  scan(target: SshTarget, credential: SshCredential, secrets: SshSecrets, log: LogSink, signal?: AbortSignal): Promise<ScanResult>
  upgrade(target: SshTarget, credential: SshCredential, secrets: SshSecrets, options: UpgradeOptions, log: LogSink, signal?: AbortSignal): Promise<{ rebootRequired: boolean }>
  reboot(target: SshTarget, credential: SshCredential, secrets: SshSecrets, log: LogSink, signal?: AbortSignal): Promise<void>
  /** Ouvre un shell interactif (terminal) ; la clé d'hôte est vérifiée comme pour la maintenance. */
  openShell(target: SshTarget, credential: SshCredential, secrets: SshSecrets, size: TerminalSize, onData: (data: string) => void, onClose: () => void): Promise<ShellHandle>
}

export interface TerminalSize {
  cols: number
  rows: number
}

export interface ShellHandle {
  write(data: string): void
  resize(size: TerminalSize): void
  close(): void
}

/** Empreinte au format OpenSSH : SHA-256 en base64 sans « = ». */
export function sshFingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export function normalizeSshFingerprint(value: string): string {
  return value.trim().replace(/^SHA256:/i, '').replace(/=+$/, '')
}

function keyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'inconnu'
  const len = key.readUInt32BE(0)
  return key.subarray(4, 4 + len).toString('ascii')
}

function sameFingerprint(expected: string, actual: string): boolean {
  const a = Buffer.from(normalizeSshFingerprint(expected))
  const b = Buffer.from(normalizeSshFingerprint(actual))
  return a.length === b.length && timingSafeEqual(a, b)
}

const line = (level: LogLevel, text: string): JobLogLine => ({ time: Date.now(), level, text })

class Session {
  constructor(private readonly client: Client) {}

  /** Exécute une commande ; la sortie d'erreur est fusionnée et la locale forcée à C pour l'analyse. */
  run(command: string, log?: LogSink, signal?: AbortSignal): Promise<{ code: number; output: string }> {
    const wrapped = `export LC_ALL=C LANG=C; { ${command} ; } 2>&1`
    return new Promise((resolve, reject) => {
      this.client.exec(wrapped, (err, stream) => {
        if (err) return reject(err)
        let output = ''
        let pending = ''
        const onAbort = () => {
          stream.signal('KILL')
          stream.close()
          reject(new DOMException('Opération annulée.', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        stream.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8')
          output += text
          if (!log) return
          pending += text
          const parts = pending.split(/\r?\n/)
          pending = parts.pop() ?? ''
          for (const p of parts) if (p.trim()) log(line('output', p))
        })
        stream.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
        stream.on('close', (code: number | null) => {
          signal?.removeEventListener('abort', onAbort)
          if (log && pending.trim()) log(line('output', pending))
          resolve({ code: code ?? -1, output })
        })
      })
    })
  }

  /** Shell interactif avec pseudo-terminal (xterm-256color). */
  shell(size: TerminalSize, onData: (data: string) => void, onClose: () => void): Promise<ShellHandle> {
    return new Promise((resolve, reject) => {
      this.client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
        if (err) {
          this.end()
          return reject(err)
        }
        // Décodage progressif : un caractère UTF-8 peut être coupé entre deux paquets.
        const out = new StringDecoder('utf8')
        const errors = new StringDecoder('utf8')
        stream.on('data', (chunk: Buffer) => onData(out.write(chunk)))
        stream.stderr.on('data', (chunk: Buffer) => onData(errors.write(chunk)))
        stream.on('close', () => {
          this.end()
          onClose()
        })
        resolve({
          write: (data) => void stream.write(data),
          resize: ({ cols, rows }) => stream.setWindow(rows, cols, 0, 0),
          close: () => {
            stream.end()
            this.end()
          },
        })
      })
    })
  }

  end() {
    this.client.end()
  }
}

/** Implémentation SSH (bibliothèque ssh2). La clé d'hôte est vérifiée avant toute authentification. */
export class SshMaintenance implements RemoteMaintenance {
  probeHostKey(host: string, port: number): Promise<HostKeyInfo> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      let captured: HostKeyInfo | null = null
      client.on('error', (error) => (captured ? resolve(captured) : reject(error)))
      client.on('close', () => (captured ? resolve(captured) : reject(new Error(`Impossible de lire la clé d'hôte de ${host}:${port}.`))))
      client.connect({
        host,
        port,
        username: 'bcenter-probe',
        readyTimeout: 15_000,
        hostVerifier: (key: Buffer) => {
          captured = { host, port, algorithm: keyAlgorithm(key), fingerprint: sshFingerprint(key) }
          return false // Interrompt volontairement l'échange après lecture de la clé.
        },
      })
    })
  }

  async testConnection(target: SshTarget, credential: SshCredential, secrets: SshSecrets): Promise<RemoteSystem> {
    const session = await this.connect(target, credential, secrets)
    try {
      return await this.systemInfo(session)
    } finally {
      session.end()
    }
  }

  async scan(target: SshTarget, credential: SshCredential, secrets: SshSecrets, log: LogSink, signal?: AbortSignal): Promise<ScanResult> {
    const session = await this.connect(target, credential, secrets, log)
    try {
      const system = await this.systemInfo(session)
      log(line('info', `Système : ${system.osName ?? '?'} ${system.osVersion ?? ''} — noyau ${system.kernel ?? '?'} — ${system.packageManager}`))
      ensureSupported(system)

      const refresh = commands.refresh(system.packageManager)
      if (refresh) {
        log(line('info', 'Actualisation des index de paquets…'))
        ensureSuccess(await session.run(privileged(refresh, credential, system), log, signal), "l'actualisation des index")
      }

      const list = await session.run(commands.listUpdates(system.packageManager), undefined, signal)
      const securityCommand = commands.listSecurity(system.packageManager)
      const security = securityCommand ? parseDnfSecurity((await session.run(securityCommand, undefined, signal)).output) : undefined
      const packages = parseUpdates(system.packageManager, list.output, security)
      for (const p of packages) {
        log(line('output', `${p.name} ${p.currentVersion ?? ''} → ${p.newVersion ?? ''}${p.security ? ' [sécurité]' : ''}`))
      }

      const rebootRequired = await this.rebootRequired(session, signal)
      return { targetId: target.id, scannedAt: new Date().toISOString(), system, packages, rebootRequired }
    } finally {
      session.end()
    }
  }

  async upgrade(target: SshTarget, credential: SshCredential, secrets: SshSecrets, options: UpgradeOptions, log: LogSink, signal?: AbortSignal) {
    const session = await this.connect(target, credential, secrets, log)
    try {
      const system = await this.systemInfo(session)
      ensureSupported(system)
      const refresh = commands.refresh(system.packageManager)
      if (refresh) ensureSuccess(await session.run(privileged(refresh, credential, system), log, signal), "l'actualisation des index")

      const result = await session.run(privileged(commands.upgrade(system.packageManager, options.fullUpgrade), credential, system), log, signal)
      ensureSuccess(result, 'la mise à jour')

      const rebootRequired = await this.rebootRequired(session, signal)
      log(line(rebootRequired ? 'warning' : 'info', rebootRequired ? 'Un redémarrage est nécessaire.' : 'Aucun redémarrage nécessaire.'))
      return { rebootRequired }
    } finally {
      session.end()
    }
  }

  async reboot(target: SshTarget, credential: SshCredential, secrets: SshSecrets, log: LogSink, signal?: AbortSignal) {
    const session = await this.connect(target, credential, secrets, log)
    try {
      const system = await this.systemInfo(session)
      ensureSuccess(await session.run(privileged(commands.reboot, credential, system), log, signal), 'la demande de redémarrage')
      log(line('info', 'Redémarrage programmé dans 2 secondes.'))
    } finally {
      session.end()
    }
  }

  async openShell(target: SshTarget, credential: SshCredential, secrets: SshSecrets, size: TerminalSize, onData: (data: string) => void, onClose: () => void) {
    const session = await this.connect(target, credential, secrets)
    return session.shell(size, onData, onClose)
  }

  private async connect(target: SshTarget, credential: SshCredential, secrets: SshSecrets, log?: LogSink): Promise<Session> {
    if (!target.hostKeyFingerprint) throw new Error(`Aucune clé d'hôte approuvée pour ${target.host}.`)

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: credential.username,
      readyTimeout: 15_000,
      keepaliveInterval: 30_000,
    }
    if (credential.authMethod === 'key') {
      if (!credential.privateKeyPath) throw new Error('Clé privée SSH non configurée.')
      config.privateKey = await readFile(credential.privateKeyPath).catch(() => {
        throw new Error(`Clé privée SSH introuvable : ${credential.privateKeyPath}`)
      })
      if (secrets.passphrase) config.passphrase = secrets.passphrase
    } else {
      if (!secrets.password) throw new Error('Mot de passe SSH absent du coffre sécurisé.')
      config.password = secrets.password
      config.tryKeyboard = true
    }

    let received: string | null = null
    config.hostVerifier = (key: Buffer) => {
      received = sshFingerprint(key)
      return sameFingerprint(target.hostKeyFingerprint, received)
    }

    log?.(line('info', `Connexion SSH à ${credential.username}@${target.host}:${target.port}…`))
    return new Promise((resolve, reject) => {
      const client = new Client()
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => secrets.password ?? '')))
      client.once('ready', () => resolve(new Session(client)))
      client.once('error', (error) => {
        if (received && !sameFingerprint(target.hostKeyFingerprint, received)) {
          reject(new Error(`La clé d'hôte de ${target.host} a changé (attendue SHA256:${target.hostKeyFingerprint}, reçue SHA256:${received}). Connexion refusée.`))
        } else if ((error as { level?: string }).level === 'client-authentication') {
          reject(new Error('Authentification SSH refusée : vérifiez l’utilisateur, la clé ou le mot de passe.'))
        } else {
          reject(error)
        }
      })
      client.connect(config)
    })
  }

  private async systemInfo(session: Session): Promise<RemoteSystem> {
    const info = await session.run(commands.systemInfo)
    const values = new Map(
      info.output
        .split('\n')
        .map((l) => l.trim().split('=', 2) as [string, string?])
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, (v ?? '').replace(/^"|"$/g, '')]),
    )
    const pm = await session.run(commands.detect)
    return {
      hostname: values.get('host') ?? '?',
      kernel: values.get('kernel'),
      osName: values.get('os'),
      osVersion: values.get('version'),
      isRoot: values.get('uid') === '0',
      packageManager: parsePackageManager(pm.output),
    }
  }

  private async rebootRequired(session: Session, signal?: AbortSignal) {
    return (await session.run(commands.rebootRequired, undefined, signal)).output.includes('yes')
  }
}

function privileged(command: string, credential: SshCredential, system: RemoteSystem) {
  return system.isRoot || !credential.useSudo ? command : `sudo -n ${command}`
}

function ensureSupported(system: RemoteSystem) {
  if (system.packageManager === 'unknown') {
    throw new Error("Aucun gestionnaire de paquets pris en charge n'a été détecté (apt, dnf, yum, apk, zypper, pacman).")
  }
}

function ensureSuccess(result: { code: number; output: string }, step: string) {
  if (result.code === 0) return
  if (/sudo: a (password|terminal) is required/i.test(result.output)) {
    throw new Error("sudo exige un mot de passe. Autorisez l'utilisateur à exécuter le gestionnaire de paquets sans mot de passe (NOPASSWD) ou utilisez root.")
  }
  throw new Error(`Échec de ${step} (code de sortie ${result.code}).`)
}
