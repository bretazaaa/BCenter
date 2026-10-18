import type {
  Alert,
  AppLogEntry,
  AppSettings,
  AppUpdateState,
  CertificateInfo,
  GuestInfo,
  HostKeyInfo,
  InfraState,
  JobHistoryEntry,
  JobInfo,
  JobLogLine,
  MetricPoint,
  MetricTimeframe,
  PowerAction,
  RemoteSystem,
  RemoteTask,
  ScanResult,
  ServerProfile,
  SnapshotInfo,
  SshCredential,
  SshTarget,
  StartupProgress,
  UpgradeOptions,
} from './types'

/** Saisie d'un serveur avant enregistrement (le secret n'est jamais renvoyé à l'interface). */
export interface ServerDraft {
  id?: string
  name: string
  host: string
  port: number
  tokenId: string
  /** Vide lors d'une modification = conserver le secret actuel. */
  tokenSecret: string
  pinnedFingerprint: string | null
}

export interface CredentialDraft {
  id?: string
  name: string
  username: string
  authMethod: 'key' | 'password'
  privateKeyPath: string | null
  useSudo: boolean
  password?: string
  passphrase?: string
}

export interface TargetDraft {
  name: string
  host: string
  port: number
  credentialId: string
  hostKey: HostKeyInfo
  guest: GuestInfo | null
}

/**
 * Contrat entre l'interface (renderer) et le moteur (main).
 * Chaque méthode correspond à un canal IPC ; les secrets ne transitent que vers le moteur.
 */
export interface BCenterApi {
  // Fenêtre et application
  windowMinimize(): Promise<void>
  windowToggleMaximize(): Promise<void>
  windowClose(): Promise<void>
  appInfo(): Promise<{ version: string; dataDir: string; logsDir: string }>
  openPath(path: 'data' | 'logs'): Promise<void>
  pickPrivateKey(): Promise<string | null>
  quit(): Promise<void>

  // Réglages et premier lancement
  getSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<AppSettings>
  completeSetup(input: { settings: AppSettings; server?: ServerDraft; credential?: CredentialDraft; testedTarget?: TargetDraft }): Promise<void>

  // Serveurs Proxmox
  listServers(): Promise<ServerProfile[]>
  probeCertificate(host: string, port: number): Promise<CertificateInfo>
  testServer(draft: ServerDraft): Promise<{ version: string }>
  saveServer(draft: ServerDraft): Promise<ServerProfile>
  removeServer(id: string): Promise<void>

  // Infrastructure
  getInfra(): Promise<InfraState>
  refreshInfra(): Promise<InfraState>
  getMetrics(serverId: string, node: string, guest: { kind: string; vmid: number } | null, timeframe: MetricTimeframe): Promise<MetricPoint[]>
  getRecentTasks(): Promise<(RemoteTask & { serverName: string })[]>
  powerAction(guest: GuestInfo, action: PowerAction): Promise<void>
  guestAddresses(guest: GuestInfo): Promise<string[]>

  // SSH
  listCredentials(): Promise<SshCredential[]>
  saveCredential(draft: CredentialDraft): Promise<SshCredential>
  removeCredential(id: string): Promise<void>
  probeHostKey(host: string, port: number): Promise<HostKeyInfo>
  testSsh(credential: CredentialDraft, host: string, port: number, hostKey: HostKeyInfo): Promise<RemoteSystem>
  listTargets(): Promise<SshTarget[]>
  addTarget(draft: TargetDraft): Promise<SshTarget>
  removeTarget(id: string): Promise<void>

  // Maintenance
  listJobs(): Promise<JobInfo[]>
  jobLog(jobId: string): Promise<JobLogLine[]>
  latestScans(): Promise<Record<string, ScanResult>>
  scan(targetIds: string[]): Promise<void>
  upgrade(targetIds: string[], options: UpgradeOptions): Promise<void>
  reboot(targetIds: string[]): Promise<void>
  rollback(targetId: string, snapshotName: string): Promise<void>
  cancelJob(jobId: string): Promise<void>
  targetSnapshots(targetId: string): Promise<SnapshotInfo[]>
  jobHistory(): Promise<JobHistoryEntry[]>

  // Shell SSH interactif
  openShell(targetId: string, cols: number, rows: number): Promise<string>
  shellWrite(sessionId: string, data: string): Promise<void>
  shellResize(sessionId: string, cols: number, rows: number): Promise<void>
  shellClose(sessionId: string): Promise<void>

  // Alertes et journaux
  listAlerts(): Promise<{ active: Alert[]; history: Alert[] }>
  acknowledgeAlert(key: string): Promise<void>
  appLogs(): Promise<AppLogEntry[]>

  // Mises à jour de BCenter
  checkAppUpdate(): Promise<AppUpdateState>
  installAppUpdate(): Promise<void>
}

/** Événements poussés par le moteur vers l'interface. */
export interface BCenterEvents {
  startup: StartupProgress
  infra: InfraState
  alerts: { active: Alert[]; history: Alert[] }
  job: JobInfo
  jobLog: { jobId: string; lines: JobLogLine[] }
  log: AppLogEntry
  maximized: boolean
  appUpdate: AppUpdateState
  navigate: string
  shellData: { id: string; data: string }
  shellExit: { id: string }
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }
