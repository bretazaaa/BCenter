import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { BCenterApi, BCenterEvents, CredentialDraft, NasDraft, ServerDraft, TargetDraft } from '@shared/api'
import { NAS_KINDS, type AlertSeverity, type ImportCandidate, type ImportProbe, type ImportResult, type NasProfile, type SshCredential, type SshTarget } from '@shared/types'
import { Logger } from './core/logger'
import { openDatabase, type Database } from './data/database'
import { JobHistoryRepository, NasRepository, ServerRepository, SettingsRepository, SshRepository } from './data/repositories'
import { secretKeys, SecretStore, type SecretCipher } from './data/secrets'
import { NasOtpRequired, type NasDriverFactory } from './nas/driver'
import { createNasDriver } from './nas'
import { ProxmoxProvider } from './proxmox/client'
import { normalizeFingerprint } from './proxmox/tls'
import { AlertEngine } from './services/alerts'
import { MaintenanceService } from './services/maintenance'
import { NasMonitor } from './services/nas'
import { InfrastructureMonitor } from './services/monitor'
import { SnapshotManager } from './services/snapshots'
import type { VirtualizationProvider } from './services/provider'
import { SshMaintenance, type RemoteMaintenance, type ShellHandle, type SshSecrets } from './ssh/client'
import { discover, knownHostFingerprints } from './ssh/importers'
import type { FileSession } from './ssh/sftp'

export interface EnginePorts {
  dataDir: string
  cipher: SecretCipher
  notify: (title: string, body: string, severity: AlertSeverity) => void
  broadcast: <K extends keyof BCenterEvents>(event: K, payload: BCenterEvents[K]) => void
  /** Substitutions (tests, démonstration). */
  provider?: VirtualizationProvider
  remote?: RemoteMaintenance
  nasDriverFactory?: NasDriverFactory
}

export type EngineApi = Omit<
  BCenterApi,
  'windowMinimize' | 'windowToggleMaximize' | 'windowClose' | 'appInfo' | 'openPath' | 'pickPrivateKey' | 'quit' | 'checkAppUpdate' | 'installAppUpdate' | 'saveSettings' | 'fsDownload' | 'fsUpload' | 'openDetached'
>

/** Taille de la fin de sortie conservée par session de terminal (reprise dans une fenêtre détachée). */
const SHELL_BUFFER = 256 * 1024

/**
 * Moteur BCenter : composition des services (sans dépendance à Electron, hors chiffrement et notifications
 * fournis par l'hôte) et implémentation des opérations exposées à l'interface.
 */
export class Engine {
  readonly logger: Logger
  readonly db: Database
  readonly settings: SettingsRepository
  readonly secrets: SecretStore
  readonly servers: ServerRepository
  readonly ssh: SshRepository
  readonly history: JobHistoryRepository
  readonly nasRepo: NasRepository
  readonly provider: VirtualizationProvider
  readonly remote: RemoteMaintenance
  readonly alerts: AlertEngine
  readonly monitor: InfrastructureMonitor
  readonly snapshots: SnapshotManager
  readonly maintenance: MaintenanceService
  readonly nas: NasMonitor
  readonly logsDir: string

  private readonly shells = new Map<string, { handle: ShellHandle; buffer: string }>()
  private readonly files = new Map<string, FileSession>()
  /** Jetons d'appareil obtenus lors d'un test (validation en deux étapes), en attente d'enregistrement. */
  private readonly pendingDevices = new Map<string, string>()
  private readonly nasFactory: NasDriverFactory

  constructor(private readonly ports: EnginePorts) {
    mkdirSync(ports.dataDir, { recursive: true })
    this.logsDir = join(ports.dataDir, 'logs')
    this.logger = new Logger(this.logsDir)
    this.logger.onEntry((entry) => ports.broadcast('log', entry))

    this.db = openDatabase(join(ports.dataDir, 'bcenter.sqlite'))
    this.settings = new SettingsRepository(this.db)
    this.secrets = new SecretStore(this.db, ports.cipher)
    this.servers = new ServerRepository(this.db, this.secrets)
    this.ssh = new SshRepository(this.db, this.secrets)
    this.history = new JobHistoryRepository(this.db)
    this.nasRepo = new NasRepository(this.db, this.secrets)

    this.provider = ports.provider ?? new ProxmoxProvider(this.secrets, this.logger.scope('Proxmox'))
    this.remote = ports.remote ?? new SshMaintenance()

    this.alerts = new AlertEngine((title, body, severity) => ports.notify(title, body, severity))
    this.alerts.onChange(() => ports.broadcast('alerts', this.alerts.list()))
    this.monitor = new InfrastructureMonitor(this.provider, this.servers, this.settings, this.alerts, this.logger.scope('Surveillance'))
    this.monitor.onChange((state) => ports.broadcast('infra', state))
    this.snapshots = new SnapshotManager(this.provider, this.servers, this.ssh, this.settings, this.logger.scope('Snapshots'))
    this.maintenance = new MaintenanceService(
      this.remote,
      this.snapshots,
      this.ssh,
      (c) => this.storedSecrets(c),
      this.history,
      this.settings,
      this.alerts,
      (title, body, severity) => ports.notify(title, body, severity),
      { job: (info) => ports.broadcast('job', info), log: (jobId, lines) => ports.broadcast('jobLog', { jobId, lines }) },
      this.logger.scope('Maintenance'),
    )
    this.nasFactory = ports.nasDriverFactory ?? createNasDriver
    this.nas = new NasMonitor(this.nasRepo, this.secrets, this.settings, this.alerts, this.nasFactory, this.logger.scope('NAS'))
    this.nas.onChange((state) => ports.broadcast('nas', state))
  }

  start(): void {
    this.monitor.start()
    this.snapshots.start()
    this.nas.reload()
    this.nas.start()
  }

  stop(): void {
    for (const shell of this.shells.values()) shell.handle.close()
    for (const session of this.files.values()) session.close()
    this.files.clear()
    this.shells.clear()
    this.maintenance.stopAll()
    this.nas.stop()
    this.monitor.stop()
    this.snapshots.stop()
    this.db.close()
  }

  /** Opérations exposées à l'interface via IPC. */
  readonly api: EngineApi = {
    getSettings: async () => this.settings.value,

    completeSetup: async ({ settings, server, credential, testedTarget }) => {
      if (server) await this.api.saveServer(server)
      let credentialId: string | undefined
      if (credential) credentialId = (await this.api.saveCredential(credential)).id
      if (testedTarget && credentialId) await this.api.addTarget({ ...testedTarget, credentialId })
      this.settings.save({ ...settings, setupCompleted: true })
      this.logger.scope('Assistant').info('Configuration initiale terminée')
      this.monitor.reloadServers()
      void this.monitor.refresh()
    },

    listServers: async () => this.servers.list(),
    probeCertificate: (host, port) => this.provider.probeCertificate(host, port),
    testServer: (draft) => this.provider.testConnection(this.profileOf(draft), draft.tokenSecret || undefined),

    saveServer: async (draft) => {
      const profile = this.profileOf(draft)
      if (draft.tokenSecret) this.secrets.set(secretKeys.serverToken(profile.id), draft.tokenSecret.trim())
      else if (!this.secrets.get(secretKeys.serverToken(profile.id))) throw new Error('Saisissez le secret du jeton API.')
      this.servers.upsert(profile)
      if (this.provider instanceof ProxmoxProvider) this.provider.invalidate(profile.id)
      this.monitor.reloadServers()
      void this.monitor.refresh()
      this.logger.scope('Serveurs').info(`Serveur ${profile.name} enregistré`)
      return profile
    },

    removeServer: async (id) => {
      this.servers.remove(id)
      if (this.provider instanceof ProxmoxProvider) this.provider.invalidate(id)
      this.monitor.reloadServers()
      void this.monitor.refresh()
    },

    getInfra: async () => this.monitor.state,
    refreshInfra: async () => {
      await this.monitor.refresh()
      return this.monitor.state
    },

    getMetrics: async (serverId, node, guest, timeframe) => {
      const server = this.requireServer(serverId)
      return guest
        ? this.provider.getGuestMetrics(server, { node, kind: guest.kind as 'qemu' | 'lxc', vmid: guest.vmid }, timeframe)
        : this.provider.getNodeMetrics(server, node, timeframe)
    },

    getRecentTasks: async () => {
      const reachable = this.monitor.state.snapshots.filter((s) => s.reachable).map((s) => s.server)
      const results = await Promise.all(
        reachable.map((server) =>
          this.provider.getRecentTasks(server, 10).then((tasks) => tasks.map((t) => ({ ...t, serverName: server.name }))).catch(() => []),
        ),
      )
      return results.flat().sort((a, b) => b.startedAt - a.startedAt).slice(0, 12)
    },

    powerAction: async (guest, action) => {
      await this.provider.powerAction(this.requireServer(guest.serverId), guest, action)
      this.logger.scope('Invités').info(`Action ${action} envoyée à ${guest.name} (${guest.vmid})`)
      setTimeout(() => void this.monitor.refresh(), 1500)
    },

    guestAddresses: (guest) => this.provider.guestAddresses(this.requireServer(guest.serverId), guest),

    listCredentials: async () => this.ssh.credentials(),
    saveCredential: async (draft) => {
      const credential = credentialOf(draft)
      this.ssh.upsertCredential(credential)
      if (draft.authMethod === 'password') {
        if (draft.password) this.secrets.set(secretKeys.sshPassword(credential.id), draft.password)
        this.secrets.delete(secretKeys.sshPassphrase(credential.id))
      } else {
        this.secrets.delete(secretKeys.sshPassword(credential.id))
        if (draft.passphrase) this.secrets.set(secretKeys.sshPassphrase(credential.id), draft.passphrase)
        else this.secrets.delete(secretKeys.sshPassphrase(credential.id))
      }
      return credential
    },
    removeCredential: async (id) => this.ssh.removeCredential(id),

    probeHostKey: (host, port) => this.remote.probeHostKey(host, port),
    testSsh: (draft, host, port, hostKey) => {
      const credential = credentialOf(draft)
      const target: SshTarget = {
        id: 'test', name: host, host, port, credentialId: credential.id,
        hostKeyFingerprint: hostKey.fingerprint, hostKeyAlgorithm: hostKey.algorithm,
        serverId: null, node: null, vmid: null, guestKind: null, group: null, tags: [],
      }
      const secrets: SshSecrets = draft.id && !draft.password && !draft.passphrase
        ? this.storedSecrets(credential)
        : { password: draft.password, passphrase: draft.passphrase }
      return this.remote.testConnection(target, credential, secrets)
    },

    listTargets: async () => this.ssh.targets(),
    addTarget: async (draft: TargetDraft) => {
      const credential = this.ssh.credentials().find((c) => c.id === draft.credentialId)
      if (!credential) throw new Error('Identifiants SSH introuvables.')
      const target: SshTarget = {
        id: randomUUID(),
        name: draft.name.trim(),
        host: draft.host.trim(),
        port: draft.port,
        credentialId: credential.id,
        hostKeyFingerprint: draft.hostKey.fingerprint,
        hostKeyAlgorithm: draft.hostKey.algorithm,
        serverId: draft.guest?.serverId ?? null,
        node: draft.guest?.node ?? null,
        vmid: draft.guest?.vmid ?? null,
        guestKind: draft.guest?.kind ?? null,
        group: draft.group?.trim() || null,
        tags: [],
      }
      await this.remote.testConnection(target, credential, this.storedSecrets(credential))
      this.ssh.upsertTarget(target)
      this.maintenance.enqueue('scan', target)
      return target
    },
    removeTarget: async (id) => {
      this.ssh.removeTarget(id)
      this.nasRepo.unlinkTarget(id)
      this.nas.reload()
    },
    linkTarget: async (id, guest) => {
      const target: SshTarget = {
        ...this.targetsOf([id])[0],
        serverId: guest?.serverId ?? null,
        node: guest?.node ?? null,
        vmid: guest?.vmid ?? null,
        guestKind: guest?.kind ?? null,
      }
      this.ssh.upsertTarget(target)
      return target
    },
    updateTarget: async (id, patch) => {
      const current = this.targetsOf([id])[0]
      if (patch.credentialId && !this.ssh.credentials().some((c) => c.id === patch.credentialId)) throw new Error('Identifiants SSH introuvables.')
      const target: SshTarget = {
        ...current,
        name: patch.name?.trim() || current.name,
        group: patch.group === undefined ? current.group : patch.group?.trim() || null,
        tags: patch.tags ? [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))] : current.tags,
        credentialId: patch.credentialId ?? current.credentialId,
      }
      this.ssh.upsertTarget(target)
      return target
    },
    discoverImports: async () => {
      const { sources, found } = await discover()
      const existing = this.ssh.targets()
      const seen = new Set<string>()
      const candidates: ImportCandidate[] = []
      for (const f of found) {
        // Une même machine déclarée dans plusieurs gestionnaires n'est proposée qu'une fois.
        const key = `${f.host.toLowerCase()}|${f.port}|${f.username ?? ''}`
        if (seen.has(key)) continue
        seen.add(key)
        const match = existing.find((t) => t.host.toLowerCase() === f.host.toLowerCase() && t.port === f.port)
        candidates.push({ ...f, id: randomUUID(), existingTargetId: match?.id ?? null })
      }
      return { sources, candidates }
    },
    probeImports: async (candidates) => {
      const knownHosts = (() => {
        try {
          return readFileSync(join(homedir(), '.ssh', 'known_hosts'), 'utf8')
        } catch {
          return ''
        }
      })()
      const probe = async (c: ImportCandidate): Promise<ImportProbe> => {
        try {
          const hostKey = await this.remote.probeHostKey(c.host, c.port)
          const known = knownHostFingerprints(knownHosts, c.host, c.port)
          return { id: c.id, hostKey, knownHosts: known.length === 0 ? 'unknown' : known.includes(hostKey.fingerprint) ? 'match' : 'mismatch' }
        } catch (error) {
          return { id: c.id, knownHosts: 'unknown', error: (error as Error).message }
        }
      }
      // Lecture en parallèle, par lots, pour ne pas saturer le réseau.
      const results: ImportProbe[] = []
      for (let i = 0; i < candidates.length; i += 8) results.push(...(await Promise.all(candidates.slice(i, i + 8).map(probe))))
      return results
    },
    importConnections: async (items) => {
      const result: ImportResult = { added: 0, linkedToProxmox: 0, errors: [] }
      const guests = this.monitor.state.snapshots.flatMap((s) => s.guests).filter((g) => !g.template)
      const created = new Map<string, SshCredential>()
      const prepared: { target: SshTarget; credential: SshCredential; name: string; linked: boolean }[] = []

      // 1. Identifiants : existants, créés depuis une clé, ou créés avec le mot de passe saisi (un seul par couple utilisateur / mot de passe).
      for (const { candidate: c, hostKey, credentialId, password } of items) {
        try {
          if (this.ssh.targets().some((t) => t.host.toLowerCase() === c.host.toLowerCase() && t.port === c.port)) throw new Error('Connexion déjà présente.')
          let credential: SshCredential | undefined
          if (credentialId === 'password') {
            if (!c.username || !password) throw new Error('Utilisateur ou mot de passe manquant.')
            const key = `${c.username}\u0000${password}`
            credential = created.get(key)
            if (!credential) {
              credential = { id: randomUUID(), name: `${c.username} (import)`, username: c.username, authMethod: 'password', privateKeyPath: null, useSudo: true }
              this.ssh.upsertCredential(credential)
              this.secrets.set(secretKeys.sshPassword(credential.id), password)
              created.set(key, credential)
            }
          } else if (credentialId === 'auto-key') {
            if (!c.keyPath || !c.username) throw new Error('Clé ou utilisateur manquant : choisissez des identifiants.')
            credential = this.ssh.credentials().find((x) => x.authMethod === 'key' && x.username === c.username && x.privateKeyPath === c.keyPath)
            if (!credential) {
              credential = { id: randomUUID(), name: `${c.username} · ${basename(c.keyPath)}`, username: c.username, authMethod: 'key', privateKeyPath: c.keyPath, useSudo: true }
              this.ssh.upsertCredential(credential)
              created.set(`key\u0000${credential.id}`, credential)
            }
          } else {
            credential = this.ssh.credentials().find((x) => x.id === credentialId)
          }
          if (!credential) throw new Error('Identifiants SSH introuvables.')
          // Rattachement automatique à l'invité Proxmox du même nom (snapshots avant mise à jour).
          const guest = guests.find((g) => g.name.toLowerCase() === c.name.toLowerCase())
          prepared.push({
            name: c.name,
            credential,
            linked: !!guest,
            target: {
              id: randomUUID(), name: c.name, host: c.host, port: c.port, credentialId: credential.id,
              hostKeyFingerprint: hostKey.fingerprint, hostKeyAlgorithm: hostKey.algorithm,
              serverId: guest?.serverId ?? null, node: guest?.node ?? null, vmid: guest?.vmid ?? null, guestKind: guest?.kind ?? null,
              group: c.group, tags: [c.source],
            },
          })
        } catch (error) {
          result.errors.push({ name: c.name, message: (error as Error).message })
        }
      }

      // 2. Vérification : connexion et authentification réelles avant l'ajout (par lots en parallèle).
      for (let i = 0; i < prepared.length; i += 6) {
        await Promise.all(prepared.slice(i, i + 6).map(async (p) => {
          try {
            await this.remote.testConnection(p.target, p.credential, this.storedSecrets(p.credential))
            this.ssh.upsertTarget(p.target)
            result.added++
            if (p.linked) result.linkedToProxmox++
          } catch (error) {
            result.errors.push({ name: p.name, message: (error as Error).message })
          }
        }))
      }

      // 3. Identifiants créés pour cet import mais utilisés par aucune connexion ajoutée : supprimés.
      const used = new Set(this.ssh.targets().map((t) => t.credentialId))
      for (const credential of created.values()) if (!used.has(credential.id)) this.ssh.removeCredential(credential.id)

      this.logger.scope('Connexions').info(`Import : ${result.added} connexion(s) ajoutée(s), ${result.errors.length} ignorée(s)`)
      return result
    },
    setCredentialSudo: async (id, useSudo) => {
      const credential = this.ssh.credentials().find((c) => c.id === id)
      if (!credential) throw new Error('Identifiants SSH introuvables.')
      this.ssh.upsertCredential({ ...credential, useSudo })
    },

    listJobs: async () => this.maintenance.list(),
    jobLog: async (id) => this.maintenance.jobLog(id),
    latestScans: async () => this.maintenance.latestScans(),
    scan: async (ids) => this.targetsOf(ids).forEach((t) => this.maintenance.enqueue('scan', t)),
    upgrade: async (ids, options) =>
      this.targetsOf(ids).forEach((t) =>
        this.maintenance.enqueue('upgrade', t, { options: { ...options, snapshotFirst: options.snapshotFirst && t.vmid != null } }),
      ),
    reboot: async (ids) => this.targetsOf(ids).forEach((t) => this.maintenance.enqueue('reboot', t)),
    rollback: async (id, name) => void this.maintenance.enqueue('rollback', this.targetsOf([id])[0], { snapshotName: name }),
    cancelJob: async (id) => this.maintenance.cancel(id),
    targetSnapshots: async (id) => this.snapshots.managed(this.targetsOf([id])[0]),
    jobHistory: async () => this.history.recent(200),

    openShell: async (targetId, cols, rows) => {
      const target = this.targetsOf([targetId])[0]
      const credential = this.ssh.credentials().find((c) => c.id === target.credentialId)
      if (!credential) throw new Error('Les identifiants SSH de cette machine sont introuvables.')
      const id = randomUUID()
      const entry = { handle: null as unknown as ShellHandle, buffer: '' }
      entry.handle = await this.remote.openShell(target, credential, this.storedSecrets(credential), { cols, rows },
        (data) => {
          // Fin de sortie conservée pour une fenêtre qui reprendrait la session (terminal détaché).
          entry.buffer = (entry.buffer + data).slice(-SHELL_BUFFER)
          this.ports.broadcast('shellData', { id, data })
        },
        () => {
          this.shells.delete(id)
          this.ports.broadcast('shellExit', { id })
        })
      this.shells.set(id, entry)
      this.logger.scope('Shell').info(`Shell ouvert sur ${target.name} (${credential.username}@${target.host})`)
      return id
    },
    shellWrite: async (id, data) => this.shells.get(id)?.handle.write(data),
    shellResize: async (id, cols, rows) => this.shells.get(id)?.handle.resize({ cols, rows }),
    shellClose: async (id) => {
      this.shells.get(id)?.handle.close()
      this.shells.delete(id)
    },
    shellAttach: async (id) => {
      const entry = this.shells.get(id)
      if (!entry) throw new Error('Cette session est terminée.')
      return entry.buffer
    },

    fsOpen: async (targetId) => {
      const target = this.targetsOf([targetId])[0]
      const credential = this.ssh.credentials().find((c) => c.id === target.credentialId)
      if (!credential) throw new Error('Les identifiants SSH de cette machine sont introuvables.')
      const session = await this.remote.openSftp(target, credential, this.storedSecrets(credential))
      const id = randomUUID()
      this.files.set(id, session)
      this.logger.scope('Fichiers').info(`Gestionnaire de fichiers ouvert sur ${target.name}`)
      return { id, home: await session.home().catch(() => '/') }
    },
    fsList: async (id, path) => this.fileSession(id).list(path),
    fsMkdir: async (id, path) => this.fileSession(id).mkdir(path),
    fsRename: async (id, from, to) => this.fileSession(id).rename(from, to),
    fsDelete: async (id, paths) => {
      for (const path of paths) await this.fileSession(id).remove(path)
    },
    fsReadText: async (id, path) => this.fileSession(id).readText(path, 2 * 1024 * 1024),
    fsWriteText: async (id, path, content) => this.fileSession(id).writeText(path, content),
    fsUploadPaths: async (id, remoteDir, localPaths) => {
      for (const local of localPaths) await this.fileSession(id).upload(local, remoteDir, this.progress(id))
      return localPaths.length
    },
    fsClose: async (id) => {
      this.files.get(id)?.close()
      this.files.delete(id)
    },

    listNas: async () => this.nasRepo.list(),
    testNas: async (draft) => {
      const profile = this.nasProfileOf(draft)
      const secret = draft.secret || (draft.id ? this.secrets.get(secretKeys.nasSecret(draft.id)) : null)
      if (!secret) throw new Error(NAS_KINDS[profile.kind].auth === 'password' ? 'Saisissez le mot de passe.' : 'Saisissez la clé ou le secret du jeton API.')
      const existing = draft.id ? this.nasRepo.find(draft.id) : undefined
      const deviceToken = existing && existing.username === profile.username ? this.secrets.get(secretKeys.nasDevice(existing.id)) : null
      const driver = this.nasFactory(profile, { secret, deviceToken, otp: draft.otp })
      try {
        const result = await driver.test()
        if (result.deviceToken) this.pendingDevices.set(pendingKey(draft), result.deviceToken)
        return { version: result.version }
      } catch (error) {
        if (error instanceof NasOtpRequired) return { otpRequired: true as const }
        throw error
      } finally {
        driver.close()
      }
    },
    saveNas: async (draft) => {
      const profile = this.nasProfileOf(draft)
      const existing = this.nasRepo.find(profile.id)
      if (draft.secret) this.secrets.set(secretKeys.nasSecret(profile.id), draft.secret)
      else if (!this.secrets.get(secretKeys.nasSecret(profile.id))) throw new Error('Saisissez le secret de connexion.')
      const device = this.pendingDevices.get(pendingKey(draft))
      this.pendingDevices.delete(pendingKey(draft))
      if (device) this.secrets.set(secretKeys.nasDevice(profile.id), device)
      else if (existing && existing.username !== profile.username) this.secrets.delete(secretKeys.nasDevice(profile.id))
      this.nasRepo.upsert(profile)
      this.nas.invalidate(profile.id)
      this.nas.reload()
      void this.nas.refresh()
      this.logger.scope('NAS').info(`NAS ${profile.name} (${NAS_KINDS[profile.kind].label}) enregistré`)
      return profile
    },
    removeNas: async (id) => {
      this.nas.invalidate(id)
      this.nasRepo.remove(id)
      this.nas.reload()
      void this.nas.refresh()
    },
    getNas: async () => this.nas.state,
    refreshNas: async () => {
      await this.nas.refresh()
      return this.nas.state
    },
    nasAction: (id, action) => this.nas.action(id, action),
    nasHistory: async (id) => this.nas.history(id),
    linkNasTarget: async (id, targetId) => {
      const nas = this.nasRepo.find(id)
      if (!nas) throw new Error('NAS introuvable.')
      if (targetId) this.targetsOf([targetId])
      const updated: NasProfile = { ...nas, sshTargetId: targetId }
      this.nasRepo.upsert(updated)
      this.nas.reload()
      return updated
    },

    listAlerts: async () => this.alerts.list(),
    acknowledgeAlert: async (key) => this.alerts.acknowledge(key),
    appLogs: async () => this.logger.recent,
  }

  /** Téléchargement vers un emplacement local (choisi par l'hôte via une boîte de dialogue). */
  async downloadTo(fsId: string, remotePaths: string[], local: string, single: boolean): Promise<void> {
    const session = this.fileSession(fsId)
    for (const remote of remotePaths) await session.download(remote, single ? local : join(local, remote.split('/').pop() || 'fichier'), this.progress(fsId))
  }

  private fileSession(id: string): FileSession {
    const session = this.files.get(id)
    if (!session) throw new Error('La session de fichiers est fermée : rouvrez le gestionnaire.')
    return session
  }

  private progress(id: string) {
    let last = 0
    return (file: string, transferred: number, total: number) => {
      // Au plus 10 notifications par seconde.
      if (transferred < total && Date.now() - last < 100) return
      last = Date.now()
      this.ports.broadcast('fsProgress', { id, file, transferred, total })
    }
  }

  private storedSecrets(credential: SshCredential): SshSecrets {
    return { password: this.secrets.get(secretKeys.sshPassword(credential.id)), passphrase: this.secrets.get(secretKeys.sshPassphrase(credential.id)) }
  }

  private profileOf(draft: ServerDraft) {
    const existing = draft.id ? this.servers.find(draft.id) : undefined
    return {
      id: draft.id ?? randomUUID(),
      name: draft.name.trim(),
      host: draft.host.trim(),
      port: draft.port,
      tokenId: draft.tokenId.trim(),
      pinnedFingerprint: draft.pinnedFingerprint ? normalizeFingerprint(draft.pinnedFingerprint) : null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
  }

  private nasProfileOf(draft: NasDraft): NasProfile {
    const kind = NAS_KINDS[draft.kind]
    if (!kind) throw new Error('Type de NAS inconnu.')
    const host = draft.host.trim()
    if (!/^[a-z0-9.\-:[\]]+$/i.test(host)) throw new Error('Adresse du NAS invalide.')
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535) throw new Error('Port invalide.')
    // TrueNAS révoque automatiquement une clé API utilisée sans chiffrement.
    if (draft.kind === 'truenas' && draft.protocol !== 'https') throw new Error('TrueNAS exige HTTPS pour l’utilisation des clés API.')
    const username = kind.auth === 'apiKey' ? null : draft.username?.trim() || null
    if (kind.auth !== 'apiKey' && !username) throw new Error(kind.auth === 'token' ? 'Saisissez l’identifiant du jeton API.' : 'Saisissez le nom d’utilisateur.')
    const existing = draft.id ? this.nasRepo.find(draft.id) : undefined
    return {
      id: draft.id ?? randomUUID(),
      name: draft.name.trim() || host,
      kind: draft.kind,
      host,
      port: draft.port,
      protocol: draft.protocol === 'http' ? 'http' : 'https',
      username,
      pinnedFingerprint: draft.protocol === 'https' && draft.pinnedFingerprint ? normalizeFingerprint(draft.pinnedFingerprint) : null,
      sshTargetId: existing?.sshTargetId ?? null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    }
  }

  private requireServer(id: string) {
    const server = this.monitor.findServer(id) ?? this.servers.find(id)
    if (!server) throw new Error('Serveur introuvable.')
    return server
  }

  private targetsOf(ids: string[]): SshTarget[] {
    const all = this.ssh.targets()
    const found = ids.map((id) => all.find((t) => t.id === id)).filter((t): t is SshTarget => !!t)
    if (found.length === 0) throw new Error('Machine introuvable.')
    return found
  }
}

const pendingKey = (draft: NasDraft) => JSON.stringify([draft.id ?? null, draft.kind, draft.host.trim(), draft.port, draft.username?.trim() ?? null])

function credentialOf(draft: CredentialDraft): SshCredential {
  return {
    id: draft.id ?? randomUUID(),
    name: draft.name.trim(),
    username: draft.username.trim(),
    authMethod: draft.authMethod,
    privateKeyPath: draft.authMethod === 'key' ? draft.privateKeyPath : null,
    useSudo: draft.useSudo,
  }
}
