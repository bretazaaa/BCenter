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
