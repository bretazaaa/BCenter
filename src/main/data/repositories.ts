import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type GuestKind,
  type JobHistoryEntry,
  type NasKind,
  type NasProfile,
  type ServerProfile,
  type SshCredential,
  type SshTarget,
} from '@shared/types'
import type { Database } from './database'
import { secretKeys, type SecretStore } from './secrets'

type Row = Record<string, unknown>

export class SettingsRepository {
  private current: AppSettings = { ...DEFAULT_SETTINGS }

  constructor(private readonly db: Database) {}

  get value(): AppSettings {
    return this.current
  }

  load(): AppSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined
    this.current = row ? { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<AppSettings>) } : { ...DEFAULT_SETTINGS }
    return this.current
  }

  save(settings: AppSettings): AppSettings {
    this.db
      .prepare("INSERT INTO settings(key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(settings))
    this.current = { ...settings }
    return this.current
  }
}

export class ServerRepository {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
  ) {}

  list(): ServerProfile[] {
    return (this.db.prepare('SELECT * FROM servers ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      host: r.host as string,
      port: Number(r.port),
      tokenId: r.token_id as string,
      pinnedFingerprint: (r.pinned_fingerprint as string | null) ?? null,
      createdAt: r.created_at as string,
    }))
  }

  find(id: string): ServerProfile | undefined {
    return this.list().find((s) => s.id === id)
  }

  upsert(s: ServerProfile): void {
    this.db
      .prepare(
        `INSERT INTO servers(id, name, host, port, token_id, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port,
           token_id = excluded.token_id, pinned_fingerprint = excluded.pinned_fingerprint`,
      )
      .run(s.id, s.name, s.host, s.port, s.tokenId, s.pinnedFingerprint, s.createdAt)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM servers WHERE id = ?').run(id)
    this.secrets.delete(secretKeys.serverToken(id))
  }
}

export class SshRepository {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
  ) {}

  credentials(): SshCredential[] {
    return (this.db.prepare('SELECT * FROM ssh_credentials ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      username: r.username as string,
      authMethod: r.auth_method as SshCredential['authMethod'],
      privateKeyPath: (r.private_key_path as string | null) ?? null,
      useSudo: Number(r.use_sudo) === 1,
    }))
  }

  upsertCredential(c: SshCredential): void {
    this.db
      .prepare(
        `INSERT INTO ssh_credentials(id, name, username, auth_method, private_key_path, use_sudo) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, username = excluded.username, auth_method = excluded.auth_method,
           private_key_path = excluded.private_key_path, use_sudo = excluded.use_sudo`,
      )
      .run(c.id, c.name, c.username, c.authMethod, c.privateKeyPath, c.useSudo ? 1 : 0)
  }

  removeCredential(id: string): void {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM ssh_targets WHERE credential_id = ?').get(id) as { n: number }
    if (Number(n) > 0) throw new Error('Ces identifiants sont encore utilisés par une ou plusieurs machines.')
    this.db.prepare('DELETE FROM ssh_credentials WHERE id = ?').run(id)
    this.secrets.delete(secretKeys.sshPassword(id))
    this.secrets.delete(secretKeys.sshPassphrase(id))
  }

  targets(): SshTarget[] {
    return (this.db.prepare('SELECT * FROM ssh_targets ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      host: r.host as string,
      port: Number(r.port),
      credentialId: r.credential_id as string,
      hostKeyFingerprint: r.host_key_fingerprint as string,
      hostKeyAlgorithm: r.host_key_algorithm as string,
      serverId: (r.server_id as string | null) ?? null,
      node: (r.node as string | null) ?? null,
      vmid: r.vmid == null ? null : Number(r.vmid),
      guestKind: (r.guest_kind as GuestKind | null) ?? null,
    }))
  }

  upsertTarget(t: SshTarget): void {
    this.db
      .prepare(
        `INSERT INTO ssh_targets(id, name, host, port, credential_id, host_key_fingerprint, host_key_algorithm, server_id, node, vmid, guest_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, host = excluded.host, port = excluded.port,
           credential_id = excluded.credential_id, host_key_fingerprint = excluded.host_key_fingerprint,
           host_key_algorithm = excluded.host_key_algorithm, server_id = excluded.server_id, node = excluded.node,
           vmid = excluded.vmid, guest_kind = excluded.guest_kind`,
      )
      .run(t.id, t.name, t.host, t.port, t.credentialId, t.hostKeyFingerprint, t.hostKeyAlgorithm, t.serverId, t.node, t.vmid, t.guestKind)
  }

  removeTarget(id: string): void {
    this.db.prepare('DELETE FROM ssh_targets WHERE id = ?').run(id)
  }
}

export class NasRepository {
  constructor(
    private readonly db: Database,
    private readonly secrets: SecretStore,
  ) {}

  list(): NasProfile[] {
    return (this.db.prepare('SELECT * FROM nas_systems ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id as string,
      name: r.name as string,
      kind: r.kind as NasKind,
      host: r.host as string,
      port: Number(r.port),
      protocol: r.protocol === 'http' ? 'http' : 'https',
      username: (r.username as string | null) ?? null,
      pinnedFingerprint: (r.pinned_fingerprint as string | null) ?? null,
      sshTargetId: (r.ssh_target_id as string | null) ?? null,
      createdAt: r.created_at as string,
    }))
  }

  find(id: string): NasProfile | undefined {
    return this.list().find((n) => n.id === id)
  }

  upsert(n: NasProfile): void {
    this.db
      .prepare(
        `INSERT INTO nas_systems(id, name, kind, host, port, protocol, username, pinned_fingerprint, ssh_target_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, host = excluded.host, port = excluded.port,
           protocol = excluded.protocol, username = excluded.username, pinned_fingerprint = excluded.pinned_fingerprint,
           ssh_target_id = excluded.ssh_target_id`,
      )
      .run(n.id, n.name, n.kind, n.host, n.port, n.protocol, n.username, n.pinnedFingerprint, n.sshTargetId, n.createdAt)
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM nas_systems WHERE id = ?').run(id)
    this.secrets.delete(secretKeys.nasSecret(id))
    this.secrets.delete(secretKeys.nasDevice(id))
  }

  /** Une machine SSH supprimée n'est plus associée à aucun NAS. */
  unlinkTarget(targetId: string): void {
    this.db.prepare('UPDATE nas_systems SET ssh_target_id = NULL WHERE ssh_target_id = ?').run(targetId)
  }
}

export class JobHistoryRepository {
  private static readonly MAX = 1000

  constructor(private readonly db: Database) {}

  add(e: JobHistoryEntry): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_history(id, kind, target_id, target_name, title, status, summary, queued_at, started_at,
           finished_at, reboot_required, snapshot_name, log) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.kind, e.targetId, e.targetName, e.title, e.status, e.summary ?? null, e.queuedAt, e.startedAt ?? null,
        e.finishedAt ?? null, e.rebootRequired ? 1 : 0, e.snapshotName ?? null, e.log)
    this.db
      .prepare('DELETE FROM job_history WHERE id NOT IN (SELECT id FROM job_history ORDER BY queued_at DESC LIMIT ?)')
      .run(JobHistoryRepository.MAX)
  }

  recent(limit: number): JobHistoryEntry[] {
    return (this.db.prepare('SELECT * FROM job_history ORDER BY queued_at DESC LIMIT ?').all(limit) as Row[]).map((r) => ({
      id: r.id as string,
      kind: r.kind as JobHistoryEntry['kind'],
      targetId: r.target_id as string,
      targetName: r.target_name as string,
      title: r.title as string,
      status: r.status as JobHistoryEntry['status'],
      summary: (r.summary as string | null) ?? undefined,
      queuedAt: Number(r.queued_at),
      startedAt: r.started_at == null ? undefined : Number(r.started_at),
      finishedAt: r.finished_at == null ? undefined : Number(r.finished_at),
      rebootRequired: Number(r.reboot_required) === 1,
      snapshotName: (r.snapshot_name as string | null) ?? undefined,
      log: r.log as string,
    }))
  }
}
