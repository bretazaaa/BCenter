// Modèles partagés entre le processus principal (moteur) et l'interface.

export type NodeStatus = 'online' | 'offline' | 'unknown'
export type GuestKind = 'qemu' | 'lxc'
export type GuestStatus = 'running' | 'stopped' | 'paused' | 'unknown'
export type PowerAction = 'start' | 'shutdown' | 'stop' | 'reboot'
export type MetricTimeframe = 'hour' | 'day' | 'week' | 'month'

export interface ServerProfile {
  id: string
  name: string
  host: string
  port: number
  /** Jeton API Proxmox : utilisateur@realm!nom. Le secret est chiffré à part (DPAPI). */
  tokenId: string
  /** Empreinte SHA-256 (hex majuscule, sans séparateur) approuvée par l'utilisateur ; null = validé par Windows. */
  pinnedFingerprint: string | null
  createdAt: string
}

export interface NodeInfo {
  serverId: string
  name: string
  status: NodeStatus
  cpu: number
  cpuCount: number
  memUsed: number
  memTotal: number
  diskUsed: number
  diskTotal: number
  uptime: number
  version?: string
}

export interface GuestInfo {
  serverId: string
  node: string
  vmid: number
  name: string
  kind: GuestKind
  status: GuestStatus
  cpu: number
  cpuCount: number
  memUsed: number
  memTotal: number
  diskTotal: number
  netIn: number
  netOut: number
  uptime: number
  template: boolean
  tags: string[]
}

export interface StorageInfo {
  serverId: string
  node: string
  name: string
  type?: string
  used: number
  total: number
  shared: boolean
  content: string[]
  active: boolean
}

export interface InfraSnapshot {
  server: ServerProfile
  timestamp: string
  reachable: boolean
  error?: string
  nodes: NodeInfo[]
  guests: GuestInfo[]
  storages: StorageInfo[]
}

export interface AggregateSample {
  time: number
  cpu: number
  mem: number
  netIn: number
  netOut: number
}

export interface InfraState {
  servers: ServerProfile[]
  snapshots: InfraSnapshot[]
  history: AggregateSample[]
  lastRefresh: string | null
}

export interface MetricPoint {
  time: number
  cpu?: number
  memUsed?: number
  memTotal?: number
  netIn?: number
  netOut?: number
  loadAvg?: number
  ioWait?: number
}

export interface RemoteTask {
  id: string
  node: string
  type: string
  user?: string
  objectId?: string
  startedAt: number
  endedAt?: number
  state: 'running' | 'ok' | 'failed'
  exitStatus?: string
}

export interface CertificateInfo {
  subject: string
  issuer: string
  fingerprint: string
  validFrom: string
  validTo: string
  trustedBySystem: boolean
  validationError?: string
}

export interface SnapshotInfo {
  name: string
  description?: string
  createdAt?: number
}

export const SNAPSHOT_PREFIX = 'bcenter-'

// ---------------------------------------------------------------- Maintenance

export type SshAuthMethod = 'key' | 'password'

export interface SshCredential {
  id: string
  name: string
  username: string
  authMethod: SshAuthMethod
  privateKeyPath: string | null
  useSudo: boolean
}

export interface SshTarget {
  id: string
  name: string
  host: string
  port: number
  credentialId: string
  /** Empreinte SHA-256 de la clé d'hôte approuvée (base64 sans remplissage, format OpenSSH). */
  hostKeyFingerprint: string
  hostKeyAlgorithm: string
  serverId: string | null
  node: string | null
  vmid: number | null
  guestKind: GuestKind | null
  /** Dossier de rangement dans la page Connexions (null = sans dossier). */
  group: string | null
  tags: string[]
}

export interface HostKeyInfo {
  host: string
  port: number
  algorithm: string
  fingerprint: string
}

export type PackageManager = 'apt' | 'dnf' | 'yum' | 'apk' | 'zypper' | 'pacman' | 'unknown'

export interface RemoteSystem {
  hostname: string
  osName?: string
  osVersion?: string
  kernel?: string
  packageManager: PackageManager
  isRoot: boolean
}

export interface PackageUpdate {
  name: string
  currentVersion?: string
  newVersion?: string
  repository?: string
  security: boolean
}

export interface ScanResult {
  targetId: string
  scannedAt: string
  system?: RemoteSystem
  packages: PackageUpdate[]
  rebootRequired: boolean
}

export interface UpgradeOptions {
  snapshotFirst: boolean
  fullUpgrade: boolean
  rebootIfRequired: boolean
}

export type JobKind = 'scan' | 'upgrade' | 'reboot' | 'rollback'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type LogLevel = 'info' | 'output' | 'warning' | 'error' | 'success'

export interface JobLogLine {
  time: number
  level: LogLevel
  text: string
}

export interface JobInfo {
  id: string
  kind: JobKind
  targetId: string
  targetName: string
  title: string
  status: JobStatus
  stage?: string
  summary?: string
  queuedAt: number
  startedAt?: number
  finishedAt?: number
  rebootRequired: boolean
  snapshotName?: string
}

export interface JobHistoryEntry extends JobInfo {
  log: string
}

// ---------------------------------------------------------------- Alertes, journaux, réglages

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface Alert {
  key: string
  severity: AlertSeverity
  title: string
  message: string
  source?: string
  raisedAt: number
  resolvedAt?: number
  acknowledged: boolean
}

export interface AppLogEntry {
  time: number
  level: 'debug' | 'info' | 'warn' | 'error'
  source: string
  message: string
}

export interface AppSettings {
  setupCompleted: boolean
  language: string
  startWithWindows: boolean
  startMinimized: boolean
  minimizeToTray: boolean
  notifications: boolean
  refreshInterval: number
  checkForUpdates: boolean
  snapshotBeforeUpdate: boolean
  snapshotRetentionDays: number
  maxParallelJobs: number
  cpuThreshold: number
  memThreshold: number
  storageThreshold: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  setupCompleted: false,
  language: 'fr-FR',
  startWithWindows: false,
  startMinimized: false,
  minimizeToTray: true,
  notifications: true,
  refreshInterval: 15,
  checkForUpdates: true,
  snapshotBeforeUpdate: true,
  snapshotRetentionDays: 7,
  maxParallelJobs: 2,
  cpuThreshold: 0.9,
  memThreshold: 0.9,
  storageThreshold: 0.85,
}

export interface StartupProgress {
  status: string
  progress: number
  error?: string
}

export type AppUpdateState =
  | { state: 'idle' | 'checking' | 'none' }
  | { state: 'available' | 'downloading'; version: string; percent?: number }
  | { state: 'ready'; version: string }
  | { state: 'error'; message: string }

// ---------------------------------------------------------------- NAS

export type NasKind = 'truenas' | 'synology' | 'unraid' | 'omv' | 'qnap' | 'pbs'

export interface NasKindInfo {
  label: string
  /** 'apiKey' : clé seule ; 'password' : utilisateur + mot de passe ; 'token' : identifiant + secret de jeton. */
  auth: 'apiKey' | 'password' | 'token'
  defaultPort: number
  defaultProtocol: 'https' | 'http'
  /** Niveau de prise en charge affiché à l'utilisateur. */
  support: 'complete' | 'basic'
}

export const NAS_KINDS: Record<NasKind, NasKindInfo> = {
  truenas: { label: 'TrueNAS (SCALE / CORE)', auth: 'apiKey', defaultPort: 443, defaultProtocol: 'https', support: 'complete' },
  synology: { label: 'Synology DSM', auth: 'password', defaultPort: 5001, defaultProtocol: 'https', support: 'complete' },
  unraid: { label: 'Unraid', auth: 'apiKey', defaultPort: 443, defaultProtocol: 'https', support: 'complete' },
  omv: { label: 'OpenMediaVault', auth: 'password', defaultPort: 443, defaultProtocol: 'https', support: 'complete' },
  qnap: { label: 'QNAP QTS / QuTS', auth: 'password', defaultPort: 443, defaultProtocol: 'https', support: 'basic' },
  pbs: { label: 'Proxmox Backup Server', auth: 'token', defaultPort: 8007, defaultProtocol: 'https', support: 'complete' },
}

export interface NasProfile {
  id: string
  name: string
  kind: NasKind
  host: string
  port: number
  protocol: 'https' | 'http'
  /** Utilisateur (Synology, OMV, QNAP) ou identifiant de jeton (PBS). Le secret est chiffré à part (DPAPI). */
  username: string | null
  /** Empreinte SHA-256 du certificat approuvée par l'utilisateur ; null = validé par Windows. */
  pinnedFingerprint: string | null
  /** Machine SSH associée (shell, mises à jour des paquets). */
  sshTargetId: string | null
  createdAt: string
}

export type NasHealth = 'healthy' | 'degraded' | 'faulted' | 'offline' | 'unknown'

export interface NasSystemInfo {
  hostname?: string
  model?: string
  version?: string
  uptime?: number
  cpu?: number
  memUsed?: number
  memTotal?: number
  temperature?: number
  rebootRequired?: boolean
  updates?: { available: boolean; version?: string; count?: number }
}

export interface NasPool {
  id: string
  name: string
  kind: 'pool' | 'volume' | 'array' | 'filesystem' | 'datastore' | 'raid' | 'cache'
  status: NasHealth
  statusText?: string
  used: number
  total: number
  detail?: string
  scrub?: { running: boolean; lastRun?: number; errors?: number }
  canScrub: boolean
}

export interface NasDisk {
  id: string
  name: string
  model?: string
  serial?: string
  size: number
  temperature?: number
  health: 'ok' | 'warning' | 'failing' | 'unknown'
  healthText?: string
  pool?: string
}

export interface NasShare {
  id: string
  name: string
  protocol: string
  path?: string
  enabled: boolean
  comment?: string
}

export interface NasService {
  id: string
  name: string
  running: boolean
  enabled?: boolean
  controllable: boolean
}

export interface NasApp {
  id: string
  name: string
  kind: 'app' | 'container' | 'vm' | 'package' | 'jail'
  state: 'running' | 'stopped' | 'error' | 'busy' | 'unknown'
  stateText?: string
  version?: string
  updateAvailable?: boolean
  controllable: boolean
}

export interface NasTask {
  id: string
  name: string
  type: 'snapshot' | 'replication' | 'cloudsync' | 'rsync' | 'backup' | 'verify' | 'prune' | 'gc' | 'sync' | 'parity' | 'cron'
  detail?: string
  enabled: boolean
  lastRun?: number
  state: 'ok' | 'failed' | 'running' | 'never' | 'unknown'
  canRun: boolean
}

export interface NasAlert {
  id: string
  level: AlertSeverity
  message: string
  time?: number
}

export type NasCapability = 'reboot' | 'shutdown' | 'update'

export interface NasSnapshot {
  nas: NasProfile
  timestamp: string
  reachable: boolean
  error?: string
  system: NasSystemInfo
  pools: NasPool[]
  disks: NasDisk[]
  shares: NasShare[]
  services: NasService[]
  apps: NasApp[]
  tasks: NasTask[]
  alerts: NasAlert[]
  capabilities: NasCapability[]
}

export interface NasState {
  systems: NasProfile[]
  snapshots: NasSnapshot[]
  lastRefresh: string | null
}

export type NasAction =
  | { kind: 'service'; id: string; op: 'start' | 'stop' | 'restart' }
  | { kind: 'app'; id: string; op: 'start' | 'stop' | 'restart' }
  | { kind: 'task'; id: string }
  | { kind: 'scrub'; poolId: string }
  | { kind: 'update' }
  | { kind: 'power'; op: 'reboot' | 'shutdown' }

/** Mesure relevée par BCenter à chaque actualisation d'un NAS (historique conservé en mémoire). */
export interface NasSample {
  time: number
  cpu?: number
  memUsed?: number
  memTotal?: number
  storageUsed: number
  storageTotal: number
  temperature?: number
  diskTemperature?: number
}

// ---------------------------------------------------------------- Import de connexions

export type ImportSource = 'xpipe' | 'ssh-config' | 'putty' | 'winscp' | 'mobaxterm'

export const IMPORT_SOURCES: Record<ImportSource, string> = {
  xpipe: 'XPipe',
  'ssh-config': 'OpenSSH (~/.ssh/config)',
  putty: 'PuTTY',
  winscp: 'WinSCP',
  mobaxterm: 'MobaXterm',
}

/** Connexion SSH trouvée dans un autre gestionnaire. Les mots de passe ne sont jamais importés. */
export interface ImportCandidate {
  id: string
  source: ImportSource
  name: string
  host: string
  port: number
  username: string | null
  keyPath: string | null
  group: string | null
  /** Connexion BCenter existante pour la même adresse et le même port. */
  existingTargetId: string | null
}

export interface ImportSourceStatus {
  source: ImportSource
  found: boolean
  count: number
  location?: string
  error?: string
}

export interface ImportProbe {
  id: string
  hostKey?: HostKeyInfo
  /** Comparaison avec ~/.ssh/known_hosts : clé déjà approuvée, différente, ou hôte inconnu. */
  knownHosts: 'match' | 'mismatch' | 'unknown'
  error?: string
}

export interface ImportItem {
  candidate: ImportCandidate
  hostKey: HostKeyInfo
  /** Identifiants existants, « auto-key » (créés depuis la clé détectée) ou « password » (créés avec le mot de passe saisi). */
  credentialId: string
  /** Mot de passe SSH saisi lors de l'import (credentialId = « password »), chiffré dès réception. */
  password?: string
}

export interface ImportResult {
  added: number
  linkedToProxmox: number
  errors: { name: string; message: string }[]
}

// ---------------------------------------------------------------- Fichiers distants (SFTP)

export interface RemoteFile {
  name: string
  path: string
  type: 'dir' | 'file' | 'link'
  size: number
  modified: number
  /** Droits au format ls (drwxr-xr-x). */
  mode: string
}

/** Fenêtre détachée : terminal (session existante ou nouvelle) ou gestionnaire de fichiers. */
export interface DetachSpec {
  kind: 'shell' | 'files'
  targetId: string
  sessionId?: string
  path?: string
}
