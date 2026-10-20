import type {
  Alert,
  AppLogEntry,
  AppSettings,
  AppUpdateState,
  CertificateInfo,
  DetachSpec,
  GuestInfo,
  HostKeyInfo,
  ImportCandidate,
  ImportItem,
  ImportProbe,
  ImportResult,
  ImportSourceStatus,
  InfraState,
  JobHistoryEntry,
  JobInfo,
  JobLogLine,
  MetricPoint,
  MetricTimeframe,
  NasAction,
  NasKind,
  NasProfile,
  NasSample,
  NasState,
  PowerAction,
  RemoteFile,
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

export interface NasDraft {
  id?: string
  name: string
  kind: NasKind
  host: string
  port: number
  protocol: 'https' | 'http'
  username: string | null
  /** Clé API, mot de passe ou secret de jeton. Vide lors d'une modification = conserver le secret actuel. */
  secret: string
  /** Code de validation en deux étapes (Synology), uniquement lors du test. */
  otp?: string
  pinnedFingerprint: string | null
}

export interface TargetPatch {
  name?: string
  group?: string | null
  tags?: string[]
  credentialId?: string
}

export interface TargetDraft {
  name: string
  host: string
  port: number
  credentialId: string
  hostKey: HostKeyInfo
  guest: GuestInfo | null
  group?: string | null
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
  /** Lie (ou délie) une machine à un invité Proxmox : active snapshots et raccourcis depuis VM / LXC. */
  linkTarget(targetId: string, guest: GuestInfo | null): Promise<SshTarget>
  setCredentialSudo(credentialId: string, useSudo: boolean): Promise<void>
  /** Modifie le nom, le dossier, les tags ou les identifiants d'une machine. */
  updateTarget(targetId: string, patch: TargetPatch): Promise<SshTarget>

  // Import depuis d'autres gestionnaires (XPipe, OpenSSH, PuTTY, WinSCP, MobaXterm)
  discoverImports(): Promise<{ sources: ImportSourceStatus[]; candidates: ImportCandidate[] }>
  /** Lit la clé d'hôte de chaque machine et la compare à ~/.ssh/known_hosts. */
  probeImports(candidates: ImportCandidate[]): Promise<ImportProbe[]>
  importConnections(items: ImportItem[]): Promise<ImportResult>

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
  /** Reprend une session existante (fenêtre détachée) ; renvoie la sortie déjà affichée. */
  shellAttach(sessionId: string): Promise<string>

  // Fichiers distants (SFTP)
  fsOpen(targetId: string): Promise<{ id: string; home: string }>
  fsList(fsId: string, path: string): Promise<RemoteFile[]>
  fsMkdir(fsId: string, path: string): Promise<void>
  fsRename(fsId: string, from: string, to: string): Promise<void>
  fsDelete(fsId: string, paths: string[]): Promise<void>
  fsReadText(fsId: string, path: string): Promise<string>
  fsWriteText(fsId: string, path: string, content: string): Promise<void>
  /** Télécharge vers un emplacement choisi dans une boîte de dialogue ; renvoie le dossier ou fichier local (null si annulé). */
  fsDownload(fsId: string, paths: string[]): Promise<string | null>
  /** Envoie des fichiers choisis dans une boîte de dialogue ; renvoie le nombre d'éléments envoyés. */
  fsUpload(fsId: string, remoteDir: string, folders: boolean): Promise<number>
  /** Envoie des fichiers ou dossiers locaux déposés dans la fenêtre. */
  fsUploadPaths(fsId: string, remoteDir: string, localPaths: string[]): Promise<number>
  fsClose(fsId: string): Promise<void>

  /** Ouvre un terminal ou un gestionnaire de fichiers dans une fenêtre séparée. */
  openDetached(spec: DetachSpec): Promise<void>

  // NAS
  listNas(): Promise<NasProfile[]>
  /** Teste la connexion ; `otpRequired` si le compte exige un code de validation en deux étapes. */
  testNas(draft: NasDraft): Promise<{ version: string } | { otpRequired: true }>
  saveNas(draft: NasDraft): Promise<NasProfile>
  removeNas(id: string): Promise<void>
  getNas(): Promise<NasState>
  refreshNas(): Promise<NasState>
  /** Exécute une action sur le NAS et renvoie le message de résultat. */
  nasAction(nasId: string, action: NasAction): Promise<string>
  /** Historique des mesures relevées depuis le démarrage de BCenter (24 h au plus). */
  nasHistory(nasId: string): Promise<NasSample[]>
  linkNasTarget(nasId: string, targetId: string | null): Promise<NasProfile>

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
  nas: NasState
  alerts: { active: Alert[]; history: Alert[] }
  job: JobInfo
  jobLog: { jobId: string; lines: JobLogLine[] }
  log: AppLogEntry
  maximized: boolean
  appUpdate: AppUpdateState
  navigate: string
  shellData: { id: string; data: string }
  shellExit: { id: string }
  fsProgress: { id: string; file: string; transferred: number; total: number }
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }
