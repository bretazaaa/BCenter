import { SNAPSHOT_PREFIX, type ServerProfile, type SnapshotInfo, type SshTarget } from '@shared/types'
import type { ScopedLogger } from '../core/logger'
import type { ServerRepository, SettingsRepository, SshRepository } from '../data/repositories'
import type { GuestRef, VirtualizationProvider } from './provider'

const PRUNE_INTERVAL = 6 * 3600_000

export const isManagedSnapshot = (s: SnapshotInfo) => s.name.startsWith(SNAPSHOT_PREFIX)

/** Nom conforme aux règles Proxmox (lettre initiale, [A-Za-z0-9_-], 40 caractères maximum). */
export function snapshotName(date: Date): string {
  const iso = date.toISOString()
  return `${SNAPSHOT_PREFIX}${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`
}

/**
 * Snapshots Proxmox pris par BCenter avant les mises à jour : création, restauration et purge.
 * Seuls les snapshots préfixés « bcenter- » sont gérés ; ceux de l'utilisateur ne sont jamais touchés.
 * Les sauvegardes planifiées (NAS, Proxmox Backup Server) restent gérées par Proxmox.
 */
export class SnapshotManager {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly provider: VirtualizationProvider,
    private readonly servers: ServerRepository,
    private readonly ssh: SshRepository,
    private readonly settings: SettingsRepository,
    private readonly log: ScopedLogger,
  ) {}

  /** Snapshots BCenter d'une machine liée, du plus récent au plus ancien. */
  async managed(target: SshTarget): Promise<SnapshotInfo[]> {
    const { server, guest } = this.resolve(target)
    return (await this.provider.listSnapshots(server, guest)).filter(isManagedSnapshot).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }

  async create(target: SshTarget, onLine: (line: string) => void, signal?: AbortSignal): Promise<string> {
    const { server, guest } = this.resolve(target)
    const name = snapshotName(new Date())
    const description = `BCenter — avant mise à jour du ${new Date().toLocaleString('fr-FR')}`
    const taskId = await this.provider.createSnapshot(server, guest, name, description)
    const task = await this.provider.waitForTask(server, guest.node, taskId, onLine, signal)
    if (task.state !== 'ok') {
      throw new Error(
        `Le snapshot a échoué (${task.exitStatus ?? 'erreur'}). Vérifiez que les disques de l'invité sont sur un stockage compatible ` +
          '(LVM-thin, ZFS, Ceph, qcow2). Mise à jour annulée.',
      )
    }
    return name
  }

  async rollback(target: SshTarget, name: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
    const { server, guest } = this.resolve(target)
    const taskId = await this.provider.rollbackSnapshot(server, guest, name)
    const task = await this.provider.waitForTask(server, guest.node, taskId, onLine, signal)
    if (task.state !== 'ok') throw new Error(`La restauration du snapshot a échoué (${task.exitStatus ?? 'erreur'}).`)
  }

  /** Supprime les snapshots BCenter plus anciens que la durée de conservation. */
  async prune(): Promise<number> {
    const limit = Date.now() - Math.max(1, this.settings.value.snapshotRetentionDays) * 86_400_000
    let deleted = 0
    for (const target of this.ssh.targets().filter((t) => t.vmid != null)) {
      try {
        const { server, guest } = this.resolve(target)
        for (const s of (await this.provider.listSnapshots(server, guest)).filter((x) => isManagedSnapshot(x) && (x.createdAt ?? Infinity) < limit)) {
          const taskId = await this.provider.deleteSnapshot(server, guest, s.name)
          await this.provider.waitForTask(server, guest.node, taskId)
          this.log.info(`Snapshot ${s.name} supprimé sur ${target.name} (conservation dépassée)`)
          deleted++
        }
      } catch (error) {
        this.log.warn(`Purge des snapshots impossible pour ${target.name} : ${(error as Error).message}`)
      }
    }
    return deleted
  }

  start(): void {
    const run = () => void this.prune().finally(() => (this.timer = setTimeout(run, PRUNE_INTERVAL)))
    this.timer = setTimeout(run, 2 * 60_000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  private resolve(target: SshTarget): { server: ServerProfile; guest: GuestRef } {
    if (!target.serverId || !target.node || target.vmid == null || !target.guestKind) {
      throw new Error("Cette machine n'est liée à aucun invité Proxmox : snapshot impossible.")
    }
    const server = this.servers.find(target.serverId)
    if (!server) throw new Error("Le serveur Proxmox lié à cette machine n'existe plus.")
    return { server, guest: { node: target.node, kind: target.guestKind, vmid: target.vmid } }
  }
}
