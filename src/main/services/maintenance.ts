import { randomUUID } from 'node:crypto'
import type { JobInfo, JobKind, JobLogLine, JobStatus, LogLevel, ScanResult, SshCredential, SshTarget, UpgradeOptions } from '@shared/types'
import type { ScopedLogger } from '../core/logger'
import type { JobHistoryRepository, SettingsRepository, SshRepository } from '../data/repositories'
import type { SshSecrets, RemoteMaintenance } from '../ssh/client'
import type { AlertEngine, Notify } from './alerts'
import type { SnapshotManager } from './snapshots'

const MAX_LOG_LINES = 20_000
const MAX_JOBS_IN_MEMORY = 200

interface Job {
  info: JobInfo
  target: SshTarget
  options?: UpgradeOptions
  log: JobLogLine[]
  controller: AbortController
}

export interface MaintenanceEvents {
  job(info: JobInfo): void
  log(jobId: string, lines: JobLogLine[]): void
}

const TITLES: Record<JobKind, string> = {
  scan: 'Analyse',
  upgrade: 'Mise à jour',
  reboot: 'Redémarrage',
  rollback: 'Restauration du snapshot',
}

/**
 * File d'exécution des opérations de maintenance. Les tâches tournent tant que le processus BCenter
 * est actif (fenêtre réduite dans la zone de notification comprise) ; elles s'arrêtent si BCenter est quitté.
 */
export class MaintenanceService {
  private readonly jobs: Job[] = []
  private readonly queue: Job[] = []
  private readonly busyTargets = new Set<string>()
  private readonly scans = new Map<string, ScanResult>()
  private readonly pendingLines = new Map<string, JobLogLine[]>()
  private flushTimer: NodeJS.Timeout | null = null
  private running = 0
  private stopped = false

  constructor(
    private readonly remote: RemoteMaintenance,
    private readonly snapshots: SnapshotManager,
    private readonly ssh: SshRepository,
    private readonly secretsFor: (credential: SshCredential) => SshSecrets,
    private readonly history: JobHistoryRepository,
    private readonly settings: SettingsRepository,
    private readonly alerts: AlertEngine,
    private readonly notify: Notify,
    private readonly events: MaintenanceEvents,
    private readonly log: ScopedLogger,
  ) {}

  get activeCount(): number {
    return this.jobs.filter((j) => j.info.status === 'queued' || j.info.status === 'running').length
  }

  list(): JobInfo[] {
    return this.jobs.map((j) => j.info)
  }

  jobLog(id: string): JobLogLine[] {
    return this.jobs.find((j) => j.info.id === id)?.log ?? []
  }

  latestScans(): Record<string, ScanResult> {
    return Object.fromEntries(this.scans)
  }

  enqueue(kind: JobKind, target: SshTarget, extra: { options?: UpgradeOptions; snapshotName?: string } = {}): JobInfo {
    const job: Job = {
      info: {
        id: randomUUID(),
        kind,
        targetId: target.id,
        targetName: target.name,
        title: `${TITLES[kind]} — ${target.name}`,
        status: 'queued',
        queuedAt: Date.now(),
        rebootRequired: false,
        snapshotName: extra.snapshotName,
      },
      target,
      options: extra.options,
      log: [],
      controller: new AbortController(),
    }
    this.jobs.unshift(job)
    if (this.jobs.length > MAX_JOBS_IN_MEMORY) {
      const finished = this.jobs.filter((j) => isFinished(j.info.status)).slice(MAX_JOBS_IN_MEMORY / 2)
      for (const old of finished) this.jobs.splice(this.jobs.indexOf(old), 1)
    }
    this.append(job, 'info', 'Tâche ajoutée à la file d’attente.')
    this.update(job, {})
    this.queue.push(job)
    this.pump()
    return job.info
  }

  cancel(id: string): void {
    const job = this.jobs.find((j) => j.info.id === id)
    if (!job || isFinished(job.info.status)) return
    job.controller.abort()
    const index = this.queue.indexOf(job)
    if (index >= 0) {
      this.queue.splice(index, 1)
      this.complete(job, 'cancelled', 'Tâche annulée avant son démarrage.')
    }
  }

  /** Interrompt toutes les tâches (fermeture de BCenter). */
  stopAll(): void {
    this.stopped = true
    for (const job of this.jobs.filter((j) => !isFinished(j.info.status))) {
      job.controller.abort()
      if (this.queue.includes(job)) this.complete(job, 'cancelled', 'Tâche interrompue : fermeture de BCenter.')
    }
    this.queue.length = 0
  }

  /** Démarre les tâches en attente dans la limite du parallélisme, une seule par machine. */
  private pump(): void {
    const max = Math.min(8, Math.max(1, this.settings.value.maxParallelJobs))
    while (!this.stopped && this.running < max) {
      const index = this.queue.findIndex((j) => !this.busyTargets.has(j.target.id))
      if (index < 0) return
      const [job] = this.queue.splice(index, 1)
      this.running++
      this.busyTargets.add(job.target.id)
      void this.execute(job).finally(() => {
        this.running--
        this.busyTargets.delete(job.target.id)
        this.pump()
      })
    }
  }

  private async execute(job: Job): Promise<void> {
    const signal = job.controller.signal
    const sink = (line: JobLogLine) => this.appendLine(job, line)
    this.update(job, { status: 'running', startedAt: Date.now() })

    try {
      switch (job.info.kind) {
        case 'scan': {
          this.stage(job, 'Analyse des mises à jour disponibles…')
          const [credential, secrets] = this.credentialOf(job.target)
          const result = await this.remote.scan(job.target, credential, secrets, sink, signal)
          this.scans.set(job.target.id, result)
          this.alerts.setRebootRequired(job.target, result.rebootRequired)
          const security = result.packages.filter((p) => p.security).length
          let summary = result.packages.length === 0 ? 'Système à jour.' : `${result.packages.length} mise(s) à jour disponible(s), dont ${security} de sécurité.`
          if (result.rebootRequired) summary += ' Redémarrage requis.'
          this.complete(job, 'succeeded', summary, result.rebootRequired)
          break
        }
        case 'upgrade':
          await this.runUpgrade(job, sink, signal)
          break
        case 'reboot': {
          this.stage(job, 'Redémarrage de la machine…')
          const [credential, secrets] = this.credentialOf(job.target)
          await this.remote.reboot(job.target, credential, secrets, sink, signal)
          this.alerts.setRebootRequired(job.target, false)
          this.scans.delete(job.target.id)
          this.complete(job, 'succeeded', 'Redémarrage demandé avec succès.')
          break
        }
        case 'rollback':
          this.stage(job, `Restauration du snapshot ${job.info.snapshotName}…`)
          await this.snapshots.rollback(job.target, job.info.snapshotName!, (l) => sink(line('output', l)), signal)
          this.scans.delete(job.target.id)
          this.alerts.setRebootRequired(job.target, false)
          this.complete(job, 'succeeded', `Snapshot ${job.info.snapshotName} restauré, invité redémarré.`)
          break
      }
    } catch (error) {
      if (signal.aborted) {
        this.complete(job, 'cancelled', this.stopped ? 'Tâche interrompue : fermeture de BCenter.' : 'Tâche annulée par l’utilisateur.')
      } else {
        this.log.error(`Échec de la tâche ${job.info.title}`, error)
        this.complete(job, 'failed', `Échec : ${(error as Error).message}`)
      }
    }
  }

  private async runUpgrade(job: Job, sink: (l: JobLogLine) => void, signal: AbortSignal): Promise<void> {
    const options = job.options ?? { snapshotFirst: true, fullUpgrade: false, rebootIfRequired: false }

    if (options.snapshotFirst) {
      if (job.target.vmid == null) throw new Error("Snapshot préalable demandé, mais cette machine n'est liée à aucun invité Proxmox. Mise à jour annulée.")
      this.stage(job, `Snapshot Proxmox de l’invité ${job.target.vmid}…`)
      const name = await this.snapshots.create(job.target, (l) => sink(line('output', l)), signal)
      this.update(job, { snapshotName: name })
      this.append(job, 'success', `Snapshot ${name} créé (conservé ${this.settings.value.snapshotRetentionDays} jour(s), restaurable depuis le centre de mises à jour).`)
    }

    this.stage(job, options.fullUpgrade ? 'Mise à niveau complète des paquets…' : 'Mise à jour des paquets…')
    const [credential, secrets] = this.credentialOf(job.target)
    const { rebootRequired } = await this.remote.upgrade(job.target, credential, secrets, options, sink, signal)
    this.scans.set(job.target.id, { targetId: job.target.id, scannedAt: new Date().toISOString(), packages: [], rebootRequired })
    this.alerts.setRebootRequired(job.target, rebootRequired)

    if (rebootRequired && options.rebootIfRequired) {
      this.stage(job, 'Redémarrage requis : redémarrage de la machine (confirmé par l’utilisateur)…')
      await this.remote.reboot(job.target, credential, secrets, sink, signal)
      this.alerts.setRebootRequired(job.target, false)
      this.complete(job, 'succeeded', 'Mise à jour terminée, machine redémarrée.')
      return
    }

    this.complete(job, 'succeeded', rebootRequired ? 'Mise à jour terminée. Un redémarrage est nécessaire.' : 'Mise à jour terminée.', rebootRequired)
  }

  private credentialOf(target: SshTarget): [SshCredential, SshSecrets] {
    const credential = this.ssh.credentials().find((c) => c.id === target.credentialId)
    if (!credential) throw new Error('Les identifiants SSH de cette machine sont introuvables.')
    return [credential, this.secretsFor(credential)]
  }

  private stage(job: Job, stage: string) {
    this.append(job, 'info', stage)
    this.update(job, { stage })
  }

  private complete(job: Job, status: JobStatus, summary: string, rebootRequired = false) {
    this.append(job, status === 'succeeded' ? 'success' : status === 'cancelled' ? 'warning' : 'error', summary)
    this.update(job, { status, summary, rebootRequired, stage: undefined, finishedAt: Date.now() })
    this.flush()

    try {
      this.history.add({ ...job.info, log: job.log.map((l) => `${new Date(l.time).toLocaleTimeString('fr-FR')} [${l.level}] ${l.text}`).join('\n') })
    } catch (error) {
      this.log.error('Impossible d’enregistrer l’historique de la tâche', error)
    }

    if (job.info.kind !== 'scan' || status === 'failed') {
      this.notify(job.info.title, summary, status === 'failed' ? 'critical' : status === 'succeeded' && !rebootRequired ? 'info' : 'warning')
    }
  }

  private update(job: Job, patch: Partial<JobInfo>) {
    job.info = { ...job.info, ...patch }
    this.events.job(job.info)
  }

  private append(job: Job, level: LogLevel, text: string) {
    this.appendLine(job, line(level, text))
  }

  /** Les lignes sont regroupées (150 ms) avant envoi à l'interface. */
  private appendLine(job: Job, entry: JobLogLine) {
    job.log.push(entry)
    if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES)
    const pending = this.pendingLines.get(job.info.id) ?? []
    pending.push(entry)
    this.pendingLines.set(job.info.id, pending)
    this.flushTimer ??= setTimeout(() => this.flush(), 150)
  }

  private flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const [id, lines] of this.pendingLines) this.events.log(id, lines)
    this.pendingLines.clear()
  }
}

const isFinished = (s: JobStatus) => s === 'succeeded' || s === 'failed' || s === 'cancelled'
const line = (level: LogLevel, text: string): JobLogLine => ({ time: Date.now(), level, text })
