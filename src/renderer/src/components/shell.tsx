import {
  Activity, Bell, CheckCircle2, Copy, HardDrive, Info, LayoutDashboard, Minus, Monitor, Network, Plus, RefreshCw, ScrollText,
  Search, Settings, Square, Terminal, Wrench, X, XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { clock } from '../lib/format'
import { useApp, type Page } from '../store'
import { Logo } from './ui'

// ------------------------------------------------------------------ Barre de titre et menus

interface MenuItem { label: string; kbd?: string; action: () => void }

function Menu({ label, items }: { label: string; items: (MenuItem | 'sep')[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className={`menu${open ? ' open' : ''}`} ref={ref}>
      <button onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && (
        <div className="menu-pop">
          {items.map((item, i) =>
            item === 'sep' ? <hr key={i} /> : (
              <button key={item.label} onClick={() => { setOpen(false); item.action() }}>
                {item.label}
                {item.kbd && <span className="kbd">{item.kbd}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

export function TitleBar({ simple = false, onAddServer }: { simple?: boolean; onAddServer?: () => void }) {
  const { maximized, navigate, refresh, toggleConsole } = useApp()
  return (
    <header className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && void api.windowToggleMaximize()}>
      <div className="brand"><Logo size={20} /> BCenter</div>
      {!simple && (
        <>
          <Menu label="Infrastructure" items={[
            { label: 'Ajouter un serveur Proxmox…', action: () => onAddServer?.() },
            { label: 'NAS', kbd: 'Ctrl+5', action: () => navigate('nas') },
            { label: 'Actualiser', kbd: 'F5', action: () => void refresh() },
            'sep',
            { label: 'Quitter BCenter', action: () => void api.quit() },
          ]} />
          <Menu label="Maintenance" items={[
            { label: 'Centre de mises à jour', kbd: 'Ctrl+3', action: () => navigate('updates') },
            { label: 'Alertes', action: () => navigate('alerts') },
            { label: 'Journal des tâches', action: () => navigate('logs') },
          ]} />
          <Menu label="Affichage" items={[
            { label: 'Afficher / masquer la console', kbd: 'Ctrl+J', action: () => toggleConsole() },
            { label: 'Dossier des données', action: () => void api.openPath('data') },
            { label: 'Dossier des journaux', action: () => void api.openPath('logs') },
            'sep',
            { label: 'Réglages', kbd: 'Ctrl+,', action: () => navigate('settings') },
          ]} />
        </>
      )}
      <div className="spacer" />
      <div className="winctl">
        <button onClick={() => void api.windowMinimize()} aria-label="Réduire"><Minus size={15} /></button>
        <button onClick={() => void api.windowToggleMaximize()} aria-label="Agrandir">{maximized ? <Copy size={12} /> : <Square size={12} />}</button>
        <button className="close" onClick={() => void api.windowClose()} aria-label="Fermer"><X size={16} /></button>
      </div>
    </header>
  )
}

// ------------------------------------------------------------------ Barre d'outils

const NAV: { page: Page; label: string; icon: ReactNode }[] = [
  { page: 'dashboard', label: 'Tableau de bord', icon: <LayoutDashboard size={17} /> },
  { page: 'infrastructure', label: 'Infrastructure', icon: <Network size={17} /> },
  { page: 'nas', label: 'NAS', icon: <HardDrive size={17} /> },
  { page: 'guests', label: 'VM / LXC', icon: <Monitor size={17} /> },
  { page: 'updates', label: 'Mises à jour', icon: <Wrench size={17} /> },
  { page: 'monitoring', label: 'Monitoring', icon: <Activity size={17} /> },
  { page: 'alerts', label: 'Alertes', icon: <Bell size={17} /> },
  { page: 'logs', label: 'Journaux', icon: <ScrollText size={17} /> },
]

export function Toolbar({ onAddServer }: { onAddServer: () => void }) {
  const { page, navigate, refresh, refreshing, search, setSearch, alerts, scans } = useApp()
  const searchRef = useRef<HTMLInputElement>(null)
  const unacknowledged = alerts.active.filter((a) => !a.acknowledged).length
  const packages = Object.values(scans).reduce((n, s) => n + (s.system ? s.packages.length : 0), 0)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.xterm')) return
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <nav className="toolbar">
      <button className="tool" onClick={onAddServer}><Plus size={17} />Ajouter</button>
      <button className="tool" onClick={() => void refresh()} disabled={refreshing}>
        <RefreshCw size={17} className={refreshing ? 'spin' : ''} />Actualiser
      </button>
      <div className="sep" />
      {NAV.map((n) => (
        <button key={n.page} className={`tool${page === n.page ? ' active' : ''}`} onClick={() => navigate(n.page)}>
          {n.icon}
          {n.label}
          {n.page === 'alerts' && unacknowledged > 0 && <span className="count danger">{unacknowledged}</span>}
          {n.page === 'updates' && packages > 0 && <span className="count">{packages}</span>}
        </button>
      ))}
      <div className="grow" />
      <label className="search">
        <Search size={14} />
        <input
          ref={searchRef}
          placeholder="Rechercher… (Ctrl+F)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && navigate('guests')}
        />
      </label>
      <button className={`tool${page === 'settings' ? ' active' : ''}`} onClick={() => navigate('settings')}>
        <Settings size={17} />Réglages
      </button>
    </nav>
  )
}

// ------------------------------------------------------------------ Barres d'état et console

export function StatusRow() {
  const { infra, nas, jobs, navigate, selectJob } = useApp()
  const reachable = infra.snapshots.filter((s) => s.reachable).length
  const total = infra.servers.length
  const nasReachable = nas.snapshots.filter((s) => s.reachable).length
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
  const running = active.find((j) => j.status === 'running')
  return (
    <div className="statusrow">
      <span className="chip">
        <span className={`dot ${total === 0 ? '' : reachable === total ? 'ok' : reachable === 0 ? 'bad' : 'warn'}`} />
        {total === 0 ? 'Aucun serveur configuré' : `Proxmox — ${reachable}/${total} serveur${total > 1 ? 's' : ''} connecté${reachable > 1 ? 's' : ''}`}
      </span>
      {nas.systems.length > 0 && (
        <button className="chip" onClick={() => navigate('nas')}>
          <span className={`dot ${nasReachable === nas.systems.length ? 'ok' : nasReachable === 0 ? 'bad' : 'warn'}`} />
          NAS — {nasReachable}/{nas.systems.length} connecté{nasReachable > 1 ? 's' : ''}
        </button>
      )}
      <span className="faint">Actualisé à {clock(infra.lastRefresh)}</span>
      {running && (
        <button className="chip on" onClick={() => void selectJob(running.id, true)}>
          <RefreshCw size={12} className="spin" /> {running.title} — {running.stage ?? 'en cours'}
        </button>
      )}
      {active.length > 1 && <button className="chip" onClick={() => navigate('updates')}>{active.length} tâches actives</button>}
    </div>
  )
}

export function StatusBar() {
  const { consoleOpen, toggleConsole, refresh, refreshing, jobs, appUpdate, navigate } = useApp()
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length
  return (
    <footer className="statusbar">
      <span>{refreshing ? 'Actualisation…' : active > 0 ? `${active} tâche(s) de maintenance en cours` : 'Prêt'}</span>
      <div className="right">
        {appUpdate.state === 'ready' && (
          <button className="chip on" onClick={() => navigate('settings')}>Mise à jour {appUpdate.version} prête</button>
        )}
        <button className={`chip${consoleOpen ? ' on' : ''}`} onClick={() => toggleConsole()}>
          <Terminal size={12} /> Console
        </button>
        <button className="chip" onClick={() => void refresh()} aria-label="Actualiser">
          <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
        </button>
        <span
          className="chip"
          title="État du moteur de BCenter : surveillance Proxmox en arrière-plan et file des tâches de maintenance. Il continue de tourner quand la fenêtre est réduite dans la zone de notification."
        >
          <span className={`dot ${active ? 'accent' : 'ok'}`} />
          {active ? `Maintenance en cours (${active})` : 'Surveillance active'}
        </span>
      </div>
    </footer>
  )
}

export function Console() {
  const { consoleTab, logs, jobs, jobLogs, selectedJobId, selectJob, toggleConsole } = useApp()
  const job = jobs.find((j) => j.id === selectedJobId)
  const lines = useMemo(
    () =>
      consoleTab === 'journal'
        ? logs.slice(-500).map((l) => ({ time: l.time, level: l.level, text: `${l.source} — ${l.message}` }))
        : (selectedJobId ? jobLogs[selectedJobId] ?? [] : []),
    [consoleTab, logs, jobLogs, selectedJobId],
  )
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [lines.length])

  return (
    <div className="console">
      <div className="head">
        <div className="segmented">
          <button className={consoleTab === 'journal' ? 'on' : ''} onClick={() => useApp.setState({ consoleTab: 'journal' })}>Journal de l’application</button>
          <button className={consoleTab === 'job' ? 'on' : ''} onClick={() => useApp.setState({ consoleTab: 'job' })}>Tâche de maintenance</button>
        </div>
        {consoleTab === 'job' && (
          <select className="select" style={{ width: 340, height: 28, marginLeft: 8 }} value={selectedJobId ?? ''} onChange={(e) => void selectJob(e.target.value || null)}>
            {jobs.length === 0 && <option value="">Aucune tâche</option>}
            {jobs.map((j) => <option key={j.id} value={j.id}>{clock(j.queuedAt)} · {j.title}</option>)}
          </select>
        )}
        {consoleTab === 'job' && job && <span className="faint" style={{ marginLeft: 10 }}>{job.summary ?? job.stage}</span>}
        <button className="btn ghost sm icon" style={{ marginLeft: 'auto' }} onClick={() => toggleConsole(false)} aria-label="Fermer la console"><X size={14} /></button>
      </div>
      <div className="body" ref={body}>
        {lines.length === 0 && <div className="faint">Aucune ligne.</div>}
        {lines.map((l, i) => (
          <div className="logline" key={i}>
            <span className="t">{clock(l.time)}</span>
            <span className={`lv-${l.level}`}>{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Toasts() {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
          {t.kind === 'success' ? <CheckCircle2 size={16} /> : t.kind === 'error' ? <XCircle size={16} /> : <Info size={16} />}
          <div className="selectable">{t.text}</div>
        </div>
      ))}
    </div>
  )
}
