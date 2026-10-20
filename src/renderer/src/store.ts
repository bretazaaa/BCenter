import { create } from 'zustand'
import type {
  Alert,
  AppLogEntry,
  AppSettings,
  AppUpdateState,
  InfraState,
  JobInfo,
  JobLogLine,
  NasState,
  ScanResult,
  ServerProfile,
  SshCredential,
  SshTarget,
} from '@shared/types'
import { api, on } from './lib/api'

export type Page = 'dashboard' | 'infrastructure' | 'nas' | 'connections' | 'guests' | 'updates' | 'monitoring' | 'alerts' | 'logs' | 'settings'

/** Onglet du panneau du bas : terminal SSH ou gestionnaire de fichiers (SFTP). */
export interface TerminalTab {
  key: string
  kind: 'shell' | 'files'
  target: SshTarget
  /** Session SSH du terminal, connue une fois ouverte (permet de la détacher sans la couper). */
  sessionId?: string
  /** Dossier courant du gestionnaire de fichiers. */
  path?: string
}

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

const MAX_JOB_LOG = 5000
let toastId = 0
let terminalId = 0
let initialized = false

interface AppStore {
  ready: boolean
  version: string
  settings: AppSettings | null
  infra: InfraState
  nas: NasState
  alerts: { active: Alert[]; history: Alert[] }
  jobs: JobInfo[]
  jobLogs: Record<string, JobLogLine[]>
  scans: Record<string, ScanResult>
  servers: ServerProfile[]
  credentials: SshCredential[]
  targets: SshTarget[]
  logs: AppLogEntry[]
  appUpdate: AppUpdateState
  maximized: boolean
  refreshing: boolean

  page: Page
  consoleOpen: boolean
  consoleTab: 'journal' | 'job'
  selectedJobId: string | null
  search: string
  toasts: Toast[]
  /** Onglets du terminal central (un onglet = une session SSH). */
  terminals: TerminalTab[]
  activeTerminal: string | null
  terminalOpen: boolean

  init(): Promise<void>
  navigate(page: Page): void
  setSearch(value: string): void
  toggleConsole(open?: boolean): void
  selectJob(id: string | null, openConsole?: boolean): Promise<void>
  refresh(): Promise<void>
  reloadLists(): Promise<void>
  saveSettings(settings: AppSettings): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  dismissToast(id: number): void
  /** Ouvre un nouvel onglet de terminal sur la machine (null masque le terminal). */
  openShell(target: SshTarget | null): void
  /** Ouvre un gestionnaire de fichiers sur la machine. */
  openFiles(target: SshTarget): void
  updateTab(key: string, patch: Partial<Pick<TerminalTab, 'sessionId' | 'path'>>): void
  closeTerminal(key: string): void
  selectTerminal(key: string): void
  toggleTerminal(open?: boolean): void
}

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  version: '',
  settings: null,
  infra: { servers: [], snapshots: [], history: [], lastRefresh: null },
  nas: { systems: [], snapshots: [], lastRefresh: null },
  alerts: { active: [], history: [] },
  jobs: [],
  jobLogs: {},
  scans: {},
  servers: [],
  credentials: [],
  targets: [],
  logs: [],
  appUpdate: { state: 'idle' },
  maximized: false,
  refreshing: false,

  page: 'dashboard',
  consoleOpen: false,
  consoleTab: 'journal',
  selectedJobId: null,
  search: '',
  toasts: [],
  terminals: [],
  activeTerminal: null,
  terminalOpen: false,

  async init() {
    if (initialized) return
    initialized = true
    on('infra', (infra) => set({ infra }))
    on('nas', (nas) => set({ nas }))
    on('alerts', (alerts) => set({ alerts }))
    on('maximized', (maximized) => set({ maximized }))
    on('navigate', (target) =>
      target === 'console' ? set({ consoleOpen: true, consoleTab: 'job' }) : set({ page: target as Page }),
    )
    on('appUpdate', (appUpdate) => set({ appUpdate }))
    on('log', (entry) => set((s) => ({ logs: [...s.logs.slice(-1999), entry] })))
    on('job', (job) =>
      set((s) => {
        const exists = s.jobs.some((j) => j.id === job.id)
        const jobs = exists ? s.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...s.jobs]
        if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled') void get().reloadLists()
        return { jobs, selectedJobId: s.selectedJobId ?? job.id }
      }),
    )
    on('jobLog', ({ jobId, lines }) =>
      set((s) => ({ jobLogs: { ...s.jobLogs, [jobId]: [...(s.jobLogs[jobId] ?? []), ...lines].slice(-MAX_JOB_LOG) } })),
    )

    const [info, settings, infra, nas, alerts, jobs, logs] = await Promise.all([
      api.appInfo(), api.getSettings(), api.getInfra(), api.getNas(), api.listAlerts(), api.listJobs(), api.appLogs(),
    ])
    set({ version: info.version, settings, infra, nas, alerts, jobs, logs, ready: true })
    // Une mise à jour trouvée pendant l'écran de démarrage a été annoncée avant que l'interface n'écoute.
    if (settings.checkForUpdates) void api.checkAppUpdate().then((appUpdate) => appUpdate.state !== 'error' && set({ appUpdate })).catch(() => undefined)
    await get().reloadLists()
  },

  navigate: (page) => set({ page }),
  setSearch: (search) => set({ search }),
  toggleConsole: (open) => set((s) => ({ consoleOpen: open ?? !s.consoleOpen })),

  async selectJob(id, openConsole = false) {
    set({ selectedJobId: id, ...(openConsole ? { consoleOpen: true, consoleTab: 'job' as const } : {}) })
    if (id && !get().jobLogs[id]) {
      const lines = await api.jobLog(id)
      set((s) => ({ jobLogs: { ...s.jobLogs, [id]: lines } }))
    }
  },

  async refresh() {
    set({ refreshing: true })
    try {
      const [infra, nas] = await Promise.all([api.refreshInfra(), api.refreshNas()])
      set({ infra, nas })
    } finally {
      set({ refreshing: false })
    }
  },

  async reloadLists() {
    const [servers, credentials, targets, scans] = await Promise.all([api.listServers(), api.listCredentials(), api.listTargets(), api.latestScans()])
    set({ servers, credentials, targets, scans })
  },

  async saveSettings(settings) {
    set({ settings: await api.saveSettings(settings) })
  },

  toast(kind, text) {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000)
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  openShell: (target) => {
    if (!target) return set({ terminalOpen: false })
    const key = `t${++terminalId}`
    set((s) => ({ terminals: [...s.terminals, { key, kind: 'shell', target }], activeTerminal: key, terminalOpen: true }))
  },
  openFiles: (target) => {
    const key = `t${++terminalId}`
    set((s) => ({ terminals: [...s.terminals, { key, kind: 'files', target }], activeTerminal: key, terminalOpen: true }))
  },
  updateTab: (key, patch) => set((s) => ({ terminals: s.terminals.map((t) => (t.key === key ? { ...t, ...patch } : t)) })),
  closeTerminal: (key) =>
    set((s) => {
      const index = s.terminals.findIndex((t) => t.key === key)
      const terminals = s.terminals.filter((t) => t.key !== key)
      const next = s.activeTerminal === key ? (terminals[index] ?? terminals[index - 1])?.key ?? null : s.activeTerminal
      return { terminals, activeTerminal: next, terminalOpen: s.terminalOpen && terminals.length > 0 }
    }),
  selectTerminal: (key) => set({ activeTerminal: key, terminalOpen: true }),
  toggleTerminal: (open) => set((s) => ({ terminalOpen: open ?? !s.terminalOpen })),
}))

/** Exécute une opération et affiche l'erreur éventuelle sous forme de notification interne. */
export async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action()
    if (success) useApp.getState().toast('success', success)
    return result
  } catch (error) {
    useApp.getState().toast('error', (error as Error).message)
    return undefined
  }
}
