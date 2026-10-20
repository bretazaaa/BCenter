import { lazy, Suspense, useEffect, useState } from 'react'
import { DialogHost } from './components/dialogs'
// Graphiques (recharts) et terminal (xterm) chargés à la demande : démarrage plus rapide.
const TerminalDock = lazy(() => import('./components/Terminal').then((m) => ({ default: m.TerminalDock })))
import { ServerModal, UpdateModal, WelcomeModal } from './components/modals'
import { Console, StatusBar, StatusRow, TitleBar, Toasts, Toolbar, type AddKind } from './components/shell'
import { Logo } from './components/ui'
import { AlertsPage } from './pages/Alerts'
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })))
import { GuestsPage } from './pages/Guests'
import { InfrastructurePage } from './pages/Infrastructure'
import { LogsPage } from './pages/Logs'
const MonitoringPage = lazy(() => import('./pages/Monitoring').then((m) => ({ default: m.MonitoringPage })))
import { ConnectionsPage } from './pages/Connections'
import { NasModal, NasPage } from './pages/Nas'
import { SettingsPage } from './pages/Settings'
import { AddTargetModal, UpdatesPage } from './pages/Updates'
import { on } from './lib/api'
import { useApp, type Page } from './store'
import { Wizard } from './wizard/Wizard'

const PAGES: Record<Page, React.ComponentType> = {
  dashboard: Dashboard,
  infrastructure: InfrastructurePage,
  nas: NasPage,
  connections: ConnectionsPage,
  guests: GuestsPage,
  updates: UpdatesPage,
  monitoring: MonitoringPage,
  alerts: AlertsPage,
  logs: LogsPage,
  settings: SettingsPage,
}

const SHORTCUTS: Record<string, Page> = { '1': 'dashboard', '2': 'infrastructure', '3': 'updates', '4': 'guests', '5': 'nas', '6': 'connections', ',': 'settings' }

export function App() {
  const { ready, settings, page, consoleOpen, version } = useApp()
  const [adding, setAdding] = useState<AddKind | null>(null)
  const [welcome, setWelcome] = useState(false)
  const appUpdate = useApp((s) => s.appUpdate)
  const [updateDismissed, setUpdateDismissed] = useState<string | null>(null)
  const readyVersion = appUpdate.state === 'ready' ? appUpdate.version : null

  useEffect(() => {
    void useApp.getState().init()
    // Une navigation demandée par le moteur (zone de notification…) ferme l'accueil.
    return on('navigate', () => setWelcome(false))
  }, [])

  // Accueil une fois par version, après la configuration initiale.
  useEffect(() => {
    if (ready && settings?.setupCompleted && version && localStorage.getItem('bcenter.welcomeSeen') !== version) setWelcome(true)
  }, [ready, settings?.setupCompleted, version])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Les raccourcis de l'application ne s'appliquent pas dans un terminal.
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
      const s = useApp.getState()
      if (e.key === 'F5') {
        e.preventDefault()
        void s.refresh()
      } else if (e.ctrlKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        s.toggleConsole()
      } else if (e.ctrlKey && SHORTCUTS[e.key]) {
        e.preventDefault()
        s.navigate(SHORTCUTS[e.key])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!ready || !settings) {
    return (
      <div className="shell">
        <TitleBar simple />
        <div className="content" style={{ display: 'grid', placeItems: 'center' }}><Logo size={72} variant="full" /></div>
      </div>
    )
  }

  if (!settings.setupCompleted) {
    return (
      <div className="shell">
        <TitleBar simple />
        <Wizard />
        <Toasts />
      </div>
    )
  }

  const Current = PAGES[page]
  return (
    <div className="shell">
      <TitleBar onAdd={setAdding} />
      <Toolbar onAdd={setAdding} />
      <main className="content">
        <Suspense fallback={null}><Current key={page} /></Suspense>
      </main>
      <Suspense fallback={null}><TerminalDock /></Suspense>
      {consoleOpen && <Console />}
      <StatusRow />
      <StatusBar />
      <Toasts />
      <DialogHost />
      {adding === 'server' && <ServerModal onClose={() => setAdding(null)} />}
      {adding === 'nas' && <NasModal onClose={() => setAdding(null)} />}
      {adding === 'target' && <AddTargetModal onClose={() => setAdding(null)} />}
      {readyVersion && readyVersion !== updateDismissed && !welcome && <UpdateModal version={readyVersion} onClose={() => setUpdateDismissed(readyVersion)} />}
      {welcome && (
        <WelcomeModal
          onClose={() => {
            localStorage.setItem('bcenter.welcomeSeen', version)
            setWelcome(false)
          }}
        />
      )}
    </div>
  )
}
