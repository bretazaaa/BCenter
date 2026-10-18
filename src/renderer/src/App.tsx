import { useEffect, useState } from 'react'
import { DialogHost } from './components/dialogs'
import { ShellWindow } from './components/ShellWindow'
import { ServerModal, WelcomeModal } from './components/modals'
import { Console, StatusBar, StatusRow, TitleBar, Toasts, Toolbar } from './components/shell'
import { Logo } from './components/ui'
import { AlertsPage } from './pages/Alerts'
import { Dashboard } from './pages/Dashboard'
import { GuestsPage } from './pages/Guests'
import { InfrastructurePage } from './pages/Infrastructure'
import { LogsPage } from './pages/Logs'
import { MonitoringPage } from './pages/Monitoring'
import { NasPage } from './pages/Nas'
import { SettingsPage } from './pages/Settings'
import { UpdatesPage } from './pages/Updates'
import { on } from './lib/api'
import { useApp, type Page } from './store'
import { Wizard } from './wizard/Wizard'

const PAGES: Record<Page, () => React.JSX.Element> = {
  dashboard: Dashboard,
  infrastructure: InfrastructurePage,
  nas: NasPage,
  guests: GuestsPage,
  updates: UpdatesPage,
  monitoring: MonitoringPage,
  alerts: AlertsPage,
  logs: LogsPage,
  settings: SettingsPage,
}

const SHORTCUTS: Record<string, Page> = { '1': 'dashboard', '2': 'infrastructure', '3': 'updates', '4': 'guests', '5': 'nas', ',': 'settings' }

export function App() {
  const { ready, settings, page, consoleOpen, version, shell, openShell } = useApp()
  const [addServer, setAddServer] = useState(false)
  const [welcome, setWelcome] = useState(false)

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
      <TitleBar onAddServer={() => setAddServer(true)} />
      <Toolbar onAddServer={() => setAddServer(true)} />
      <main className="content">
        <Current key={page} />
      </main>
      {consoleOpen && <Console />}
      <StatusRow />
      <StatusBar />
      <Toasts />
      <DialogHost />
      {shell && <ShellWindow key={shell.id} target={shell} onClose={() => openShell(null)} />}
      {addServer && <ServerModal onClose={() => setAddServer(false)} />}
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
