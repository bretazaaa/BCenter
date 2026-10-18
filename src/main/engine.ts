import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BCenterApi, BCenterEvents, CredentialDraft, ServerDraft, TargetDraft } from '@shared/api'
import type { AlertSeverity, SshCredential, SshTarget } from '@shared/types'
import { Logger } from './core/logger'
import { openDatabase, type Database } from './data/database'
import { JobHistoryRepository, ServerRepository, SettingsRepository, SshRepository } from './data/repositories'
import { secretKeys, SecretStore, type SecretCipher } from './data/secrets'
import { ProxmoxProvider } from './proxmox/client'
import { normalizeFingerprint } from './proxmox/tls'
import { AlertEngine } from './services/alerts'
import { MaintenanceService } from './services/maintenance'
import { InfrastructureMonitor } from './services/monitor'
import { SnapshotManager } from './services/snapshots'
import type { VirtualizationProvider } from './services/provider'
import { SshMaintenance, type RemoteMaintenance, type ShellHandle, type SshSecrets } from './ssh/client'

export interface EnginePorts {
  dataDir: string
  cipher: SecretCipher
  notify: (title: string, body: string, severity: AlertSeverity) => void
  broadcast: <K extends keyof BCenterEvents>(event: K, payload: BCenterEvents[K]) => void
  /** Substitutions (tests, démonstration). */
  provider?: VirtualizationProvider
  remote?: RemoteMaintenance
}

export type EngineApi = Omit<
  BCenterApi,
  'windowMinimize' | 'windowToggleMaximize' | 'windowClose' | 'appInfo' | 'openPath' | 'pickPrivateKey' | 'quit' | 'checkAppUpdate' | 'installAppUpdate' | 'saveSettings'
>

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
  readonly provider: VirtualizationProvider
  readonly remote: RemoteMaintenance
  readonly alerts: AlertEngine
  readonly monitor: InfrastructureMonitor
  readonly snapshots: SnapshotManager
  readonly maintenance: MaintenanceService
  readonly logsDir: string

  private readonly shells = new Map<string, ShellHandle>()

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
  }

  start(): void {
    this.monitor.start()
    this.snapshots.start()
  }

  stop(): void {
    for (const shell of this.shells.values()) shell.close()
    this.shells.clear()
    this.maintenance.stopAll()
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
        serverId: null, node: null, vmid: null, guestKind: null,
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
      }
      await this.remote.testConnection(target, credential, this.storedSecrets(credential))
      this.ssh.upsertTarget(target)
      this.maintenance.enqueue('scan', target)
      return target
    },
    removeTarget: async (id) => this.ssh.removeTarget(id),

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
      const handle = await this.remote.openShell(target, credential, this.storedSecrets(credential), { cols, rows },
        (data) => this.ports.broadcast('shellData', { id, data }),
        () => {
          this.shells.delete(id)
          this.ports.broadcast('shellExit', { id })
        })
      this.shells.set(id, handle)
      this.logger.scope('Shell').info(`Shell ouvert sur ${target.name} (${credential.username}@${target.host})`)
      return id
    },
    shellWrite: async (id, data) => this.shells.get(id)?.write(data),
    shellResize: async (id, cols, rows) => this.shells.get(id)?.resize({ cols, rows }),
    shellClose: async (id) => {
      this.shells.get(id)?.close()
      this.shells.delete(id)
    },

    listAlerts: async () => this.alerts.list(),
    acknowledgeAlert: async (key) => this.alerts.acknowledge(key),
    appLogs: async () => this.logger.recent,
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
