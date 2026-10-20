import { DatabaseSync } from 'node:sqlite'

/** Migrations successives ; l'index + 1 est stocké dans PRAGMA user_version. */
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE secrets (key TEXT PRIMARY KEY, protected BLOB NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE servers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
    token_id TEXT NOT NULL, pinned_fingerprint TEXT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE ssh_credentials (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL, auth_method TEXT NOT NULL,
    private_key_path TEXT NULL, use_sudo INTEGER NOT NULL
  );
  CREATE TABLE ssh_targets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
    credential_id TEXT NOT NULL REFERENCES ssh_credentials(id),
    host_key_fingerprint TEXT NOT NULL, host_key_algorithm TEXT NOT NULL,
    server_id TEXT NULL, node TEXT NULL, vmid INTEGER NULL, guest_kind TEXT NULL
  );
  CREATE TABLE job_history (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL,
    title TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NULL, queued_at INTEGER NOT NULL,
    started_at INTEGER NULL, finished_at INTEGER NULL, reboot_required INTEGER NOT NULL,
    snapshot_name TEXT NULL, log TEXT NOT NULL
  );
  CREATE INDEX ix_job_history_queued ON job_history(queued_at DESC);
  `,
  `
  CREATE TABLE nas_systems (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
    protocol TEXT NOT NULL, username TEXT NULL, pinned_fingerprint TEXT NULL, ssh_target_id TEXT NULL, created_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE ssh_targets ADD COLUMN group_name TEXT NULL;
  ALTER TABLE ssh_targets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
  `,
]

export type Database = DatabaseSync

/** Ouvre (ou crée) la base SQLite locale et applique les migrations. */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

  const { user_version: version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return db
}
