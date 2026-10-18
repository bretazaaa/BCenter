import type {
  CertificateInfo,
  GuestInfo,
  GuestKind,
  InfraSnapshot,
  MetricPoint,
  MetricTimeframe,
  PowerAction,
  RemoteTask,
  ServerProfile,
  SnapshotInfo,
} from '@shared/types'

export interface GuestRef {
  node: string
  kind: GuestKind
  vmid: number
}

/**
 * Contrat d'une plateforme de virtualisation. Proxmox VE est la première implémentation ;
 * une autre plateforme s'ajoute en implémentant cette interface.
 */
export interface VirtualizationProvider {
  probeCertificate(host: string, port: number): Promise<CertificateInfo>
  /** Vérifie l'authentification ; `secret` remplace le secret enregistré (test avant enregistrement). */
  testConnection(server: ServerProfile, secret?: string): Promise<{ version: string }>
  getSnapshot(server: ServerProfile, signal?: AbortSignal): Promise<InfraSnapshot>
  getNodeMetrics(server: ServerProfile, node: string, timeframe: MetricTimeframe): Promise<MetricPoint[]>
  getGuestMetrics(server: ServerProfile, guest: GuestRef, timeframe: MetricTimeframe): Promise<MetricPoint[]>
  getRecentTasks(server: ServerProfile, limit: number): Promise<RemoteTask[]>
  powerAction(server: ServerProfile, guest: GuestInfo, action: PowerAction): Promise<string>
  guestAddresses(server: ServerProfile, guest: GuestInfo): Promise<string[]>
  listSnapshots(server: ServerProfile, guest: GuestRef): Promise<SnapshotInfo[]>
  createSnapshot(server: ServerProfile, guest: GuestRef, name: string, description: string): Promise<string>
  rollbackSnapshot(server: ServerProfile, guest: GuestRef, name: string): Promise<string>
  deleteSnapshot(server: ServerProfile, guest: GuestRef, name: string): Promise<string>
  /** Attend la fin d'une tâche distante en relayant son journal. */
  waitForTask(server: ServerProfile, node: string, taskId: string, onLine?: (line: string) => void, signal?: AbortSignal): Promise<RemoteTask>
}
