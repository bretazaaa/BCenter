import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, shell, Tray } from 'electron'
import type { ApiResult, BCenterApi, BCenterEvents } from '@shared/api'
import type { AlertSeverity, AppSettings } from '@shared/types'
import { createDemoPorts, seedDemo } from './demo'
import { Engine } from './engine'
import { AppUpdater } from './updater'

const isDemo = process.argv.includes('--demo') || process.env.BCENTER_DEMO === '1'
const startMinimized = process.argv.includes('--minimized')
const dataDir =
  process.env.BCENTER_DATA_DIR ??
  join(process.env.LOCALAPPDATA ?? app.getPath('appData'), isDemo ? 'BCenter-demo' : 'BCenter')

app.setPath('userData', join(dataDir, 'webdata'))
app.setAppUserModelId('com.bcenter.app')

let engine: Engine | null = null
let mainWindow: BrowserWindow | null = null
let splash: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let trayHintShown = false
const updater = new AppUpdater((state) => broadcast('appUpdate', state))

const preload = join(import.meta.dirname, '../preload/index.mjs')
const iconPath = app.isPackaged ? join(process.resourcesPath, 'tray.ico') : join(import.meta.dirname, '../../src/main/tray.ico')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showMain())
  app.whenReady().then(boot).catch((error) => fatal(error))
}

function broadcast<K extends keyof BCenterEvents>(event: K, payload: BCenterEvents[K]) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(`event:${event}`, payload)
}

function loadRenderer(win: BrowserWindow, route: string) {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${route}`)
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'), { hash: route })
}

function notify(title: string, body: string, severity: AlertSeverity) {
  if (!engine?.settings.value.notifications || !Notification.isSupported()) return
  new Notification({ title, body, icon: iconPath, urgency: severity === 'critical' ? 'critical' : 'normal' }).show()
}

/** Démarrage : chaque étape réelle est affichée par l'écran de démarrage. */
async function boot() {
  splash = new BrowserWindow({
    width: 560, height: 400, frame: false, transparent: true, resizable: false, show: false, center: true,
    skipTaskbar: false, icon: iconPath, title: 'BCenter',
    webPreferences: { preload, sandbox: false, contextIsolation: true },
  })
  splash.once('ready-to-show', () => splash?.show())
  loadRenderer(splash, '/splash')
  registerIpc()

  const step = async (status: string, progress: number) => {
    broadcast('startup', { status, progress })
    await new Promise((r) => setTimeout(r, 120)) // Laisse l'animation se rafraîchir entre deux étapes.
  }

  try {
    await new Promise<void>((r) => splash!.webContents.once('did-finish-load', () => r()))
    await step('Ouverture de la base de données locale…', 0.1)
    const ports = {
      dataDir,
      notify,
      broadcast,
      cipher: {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain: string) => safeStorage.encryptString(plain),
        decrypt: (data: Buffer) => safeStorage.decryptString(data),
      },
    }
    engine = new Engine(isDemo ? createDemoPorts(ports) : ports)
    const log = engine.logger.scope('BCenter')
    log.info(`Démarrage de BCenter ${app.getVersion()}${isDemo ? ' (démonstration)' : ''}`)

    await step('Chargement des paramètres…', 0.25)
    const settings = engine.settings.load()
    if (isDemo) seedDemo(engine)

    await step('Vérification du coffre sécurisé Windows (DPAPI)…', 0.4)
    if (!engine.secrets.selfTest()) throw new Error('Le coffre sécurisé Windows (DPAPI) est indisponible pour ce compte utilisateur.')

    await step('Chargement des serveurs enregistrés…', 0.52)
    engine.monitor.reloadServers()
    const count = engine.monitor.state.servers.length
    if (count > 0) {
      await step(`Connexion à ${count} serveur(s)…`, 0.65)
      await Promise.race([engine.monitor.refresh(), new Promise((r) => setTimeout(r, 12_000))])
    }

    if (settings.checkForUpdates && app.isPackaged) {
      await step('Recherche d’une nouvelle version de BCenter…', 0.82)
      await Promise.race([updater.check(), new Promise((r) => setTimeout(r, 6000))])
    }

    await step('Démarrage des services d’arrière-plan…', 0.92)
    engine.start()
    createTray()
    createMainWindow()
    await new Promise<void>((r) => mainWindow!.once('ready-to-show', () => r()))
    await step('Prêt', 1)
    await new Promise((r) => setTimeout(r, 450))
    splash.close()
    splash = null

    if (settings.checkForUpdates && app.isPackaged) updater.schedule()
    if (startMinimized && settings.setupCompleted) notify('BCenter', 'BCenter fonctionne en arrière-plan dans la zone de notification.', 'info')
    else showMain()

  } catch (error) {
    fatal(error)
  }
}

function fatal(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  engine?.logger.scope('BCenter').error('Échec du démarrage', error)
  broadcast('startup', { status: 'Échec du démarrage', progress: 1, error: message })
  dialog.showErrorBox('BCenter', `BCenter n’a pas pu démarrer.\n\n${message}\n\nJournaux : ${join(dataDir, 'logs')}`)
  app.exit(1)
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680, show: false, frame: false,
    backgroundColor: '#0b0c10', title: 'BCenter', icon: iconPath,
    webPreferences: { preload, sandbox: false, contextIsolation: true, spellcheck: false },
  })
  mainWindow.on('maximize', () => broadcast('maximized', true))
  mainWindow.on('unmaximize', () => broadcast('maximized', false))
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    if (engine?.settings.value.minimizeToTray) {
      mainWindow?.hide()
      if (!trayHintShown) {
        trayHintShown = true
        notify('BCenter reste actif', 'La surveillance et les tâches en cours continuent. Clic droit sur l’icône pour quitter.', 'info')
      }
    } else {
      void requestQuit()
    }
  })
  // Liens externes dans le navigateur, jamais dans l'application.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  loadRenderer(mainWindow, '/')
}

function showMain() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  tray = new Tray(iconPath)
  tray.setToolTip('BCenter')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir BCenter', click: showMain },
      { label: 'Actualiser l’infrastructure', click: () => void engine?.monitor.refresh() },
      { type: 'separator' },
      { label: 'Quitter BCenter', click: () => void requestQuit() },
    ]),
  )
  tray.on('click', showMain)
  engine?.monitor.onChange((state) => {
    const online = state.snapshots.filter((s) => s.reachable).length
    const jobs = engine?.maintenance.activeCount ?? 0
    tray?.setToolTip(`BCenter — ${online}/${state.servers.length} serveur(s) connecté(s)${jobs ? ` · ${jobs} tâche(s) en cours` : ''}`)
  })
}

/** Quitter : confirmation si des tâches de maintenance sont en cours. */
async function requestQuit(): Promise<void> {
  const active = engine?.maintenance.activeCount ?? 0
  if (active > 0) {
    showMain()
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Quitter BCenter',
      message: `${active} tâche(s) de maintenance sont en cours ou en attente.`,
      detail: 'Elles seront interrompues si vous quittez BCenter.',
      buttons: ['Annuler', 'Quitter quand même'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return
  }
  quitting = true
  engine?.logger.scope('BCenter').info('Arrêt de BCenter')
  engine?.stop()
  tray?.destroy()
  app.quit()
}

function applyStartup(settings: AppSettings) {
  if (!app.isPackaged) return // En développement, l'exécutable est celui d'Electron.
  app.setLoginItemSettings({ openAtLogin: settings.startWithWindows, args: settings.startMinimized ? ['--minimized'] : [] })
}

function registerIpc() {
  const host: Pick<BCenterApi, 'windowMinimize' | 'windowToggleMaximize' | 'windowClose' | 'appInfo' | 'openPath' | 'pickPrivateKey' | 'quit' | 'checkAppUpdate' | 'installAppUpdate' | 'saveSettings'> = {
    windowMinimize: async () => BrowserWindow.getFocusedWindow()?.minimize(),
    windowToggleMaximize: async () => {
      const win = BrowserWindow.getFocusedWindow()
      if (win) (win.isMaximized() ? win.unmaximize() : win.maximize())
    },
    windowClose: async () => BrowserWindow.getFocusedWindow()?.close(),
    appInfo: async () => ({ version: app.getVersion(), dataDir, logsDir: join(dataDir, 'logs') }),
    openPath: async (which) => void shell.openPath(which === 'logs' ? join(dataDir, 'logs') : dataDir),
    pickPrivateKey: async () => {
      const result = await dialog.showOpenDialog(mainWindow ?? BrowserWindow.getFocusedWindow()!, {
        title: 'Sélectionner une clé privée SSH',
        defaultPath: join(app.getPath('home'), '.ssh'),
        properties: ['openFile', 'showHiddenFiles'],
      })
      return result.canceled ? null : result.filePaths[0]
    },
    quit: () => requestQuit(),
    checkAppUpdate: () => updater.check(),
    installAppUpdate: async () => {
      quitting = true
      engine?.stop()
      updater.install()
    },
    saveSettings: async (settings) => {
      const saved = engine!.settings.save(settings)
      applyStartup(saved)
      void engine!.monitor.refresh()
      return saved
    },
  }

  ipcMain.handle('api', async (_event, name: keyof BCenterApi, args: unknown[]): Promise<ApiResult<unknown>> => {
    try {
      const handler = (name in host ? host[name as keyof typeof host] : engine?.api[name as keyof Engine['api']]) as
        | ((...a: unknown[]) => Promise<unknown>)
        | undefined
      if (!handler) throw new Error(`Opération inconnue : ${String(name)}`)
      if (name === 'completeSetup') applyStartup((args[0] as { settings: AppSettings }).settings)
      return { ok: true, value: await handler(...args) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}

app.on('window-all-closed', () => {
  // L'application reste active dans la zone de notification.
})

app.on('before-quit', () => {
  if (!quitting) {
    quitting = true
    engine?.stop()
  }
})
