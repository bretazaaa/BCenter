import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { AppUpdateState } from '@shared/types'

const { autoUpdater } = electronUpdater

/** Dépôt public où sont publiées les versions (Releases GitHub : installeur + latest.yml). */
export const UPDATE_REPOSITORY = 'bretazaaa/BCenter'
const CHECK_INTERVAL = 6 * 3600_000

/**
 * Mises à jour de BCenter via electron-updater et les Releases GitHub.
 * La nouvelle version est téléchargée en arrière-plan puis installée à la demande de l'utilisateur.
 */
export class AppUpdater {
  private state: AppUpdateState = { state: 'idle' }
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onState: (state: AppUpdateState) => void) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    // Configuration explicite (identique à celle écrite par electron-builder dans app-update.yml).
    const [owner, repo] = UPDATE_REPOSITORY.split('/')
    autoUpdater.setFeedURL({ provider: 'github', owner, repo, releaseType: 'release' })
    autoUpdater.on('checking-for-update', () => this.set({ state: 'checking' }))
    autoUpdater.on('update-not-available', () => this.set({ state: 'none' }))
    autoUpdater.on('update-available', (info) => this.set({ state: 'available', version: info.version }))
    autoUpdater.on('download-progress', (p) => this.set({ state: 'downloading', version: this.version(), percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', (info) => this.set({ state: 'ready', version: info.version }))
    autoUpdater.on('error', (error) => this.set({ state: 'error', message: error.message }))
  }

  async check(): Promise<AppUpdateState> {
    if (!installed()) return this.set({ state: 'error', message: 'Cette copie de BCenter n’a pas été installée avec l’installateur (version de test) : utilisez la version installée pour les mises à jour.' })
    if (['checking', 'available', 'downloading', 'ready'].includes(this.state.state)) return this.state
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      this.set({ state: 'error', message: (error as Error).message })
    }
    return this.state
  }

  /**
   * Au démarrage : cherche une nouvelle version et la télécharge (progression transmise à l'écran de démarrage).
   * Renvoie la version prête à installer, ou null (à jour, hors ligne, ou téléchargement trop long : il continue
   * alors en arrière-plan et sera proposé plus tard).
   */
  async prepareAtStartup(onProgress: (version: string, percent: number) => void, timeoutMs = 120_000): Promise<string | null> {
    if (!installed()) return null
    try {
      const result = await Promise.race([autoUpdater.checkForUpdates(), new Promise<null>((r) => setTimeout(() => r(null), 8000))])
      const version = result?.isUpdateAvailable ? result.updateInfo.version : null
      if (!version || !result?.downloadPromise) return null
      const progress = (p: { percent: number }) => onProgress(version, Math.round(p.percent))
      autoUpdater.on('download-progress', progress)
      try {
        const done = await Promise.race([result.downloadPromise.then(() => true), new Promise<false>((r) => setTimeout(() => r(false), timeoutMs))])
        return done ? version : null
      } finally {
        autoUpdater.off('download-progress', progress)
      }
    } catch (error) {
      this.set({ state: 'error', message: (error as Error).message })
      return null
    }
  }

  /** Vérification périodique tant que BCenter est lancé. */
  schedule(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL)
  }

  install(): void {
    // Installation silencieuse (aucun assistant), puis relance automatique de BCenter.
    autoUpdater.quitAndInstall(true, true)
  }

  private version() {
    return 'version' in this.state ? this.state.version : ''
  }

  private set(state: AppUpdateState): AppUpdateState {
    this.state = state
    this.onState(state)
    return state
  }
}

/** Copie installée par l'installateur (qui fournit app-update.yml), et non version de développement ou de test. */
function installed(): boolean {
  return app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
}
