import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppLogEntry } from '@shared/types'

type Level = AppLogEntry['level']

const CAPACITY = 2000
const RETENTION_DAYS = 14

/**
 * Journal applicatif : fichier quotidien dans le dossier des journaux + mémoire tampon pour l'écran « Journaux ».
 * Règle : aucun secret (jeton, mot de passe, phrase de passe) ne doit jamais être passé au journal.
 */
export class Logger {
  private readonly entries: AppLogEntry[] = []
  private readonly listeners = new Set<(entry: AppLogEntry) => void>()
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly logsDir: string | null) {
    if (logsDir) {
      void mkdir(logsDir, { recursive: true }).then(() => this.prune())
    }
  }

  scope(source: string): ScopedLogger {
    return {
      debug: (m) => this.write('debug', source, m),
      info: (m) => this.write('info', source, m),
      warn: (m) => this.write('warn', source, m),
      error: (m, e) => this.write('error', source, e ? `${m} : ${errorMessage(e)}` : m, e),
    }
  }

  get recent(): AppLogEntry[] {
    return [...this.entries]
  }

  onEntry(listener: (entry: AppLogEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private write(level: Level, source: string, message: string, error?: unknown): void {
    const entry: AppLogEntry = { time: Date.now(), level, source, message }
    if (level !== 'debug') {
      this.entries.push(entry)
      if (this.entries.length > CAPACITY) this.entries.splice(0, this.entries.length - CAPACITY)
      for (const listener of this.listeners) listener(entry)
    }

    if (!this.logsDir) return
    const stamp = new Date(entry.time)
    const line = `${stamp.toISOString()} [${level.toUpperCase().padEnd(5)}] ${source}: ${message}${
      error instanceof Error && error.stack ? `\n${error.stack}` : ''
    }\n`
    const file = join(this.logsDir, `bcenter-${stamp.toISOString().slice(0, 10)}.log`)
    this.queue = this.queue.then(() => appendFile(file, line, 'utf8')).catch(() => undefined)
  }

  private async prune(): Promise<void> {
    if (!this.logsDir) return
    const limit = Date.now() - RETENTION_DAYS * 86_400_000
    for (const name of await readdir(this.logsDir).catch(() => [] as string[])) {
      const match = /^bcenter-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
      if (match && Date.parse(match[1]) < limit) await unlink(join(this.logsDir, name)).catch(() => undefined)
    }
  }
}

export interface ScopedLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Journal silencieux pour les tests. */
export const nullLogger: ScopedLogger = { debug() {}, info() {}, warn() {}, error() {} }
