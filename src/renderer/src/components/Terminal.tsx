import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, ExternalLink, FolderOpen, Maximize2, Minimize2, Plus, RefreshCw, TerminalSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SshTarget } from '@shared/types'
import { api, on } from '../lib/api'
import { useApp, type TerminalTab } from '../store'
import { FileBrowser } from './FileBrowser'

type State = 'connecting' | 'open' | 'closed' | 'error'

const THEME = {
  background: '#08090c', foreground: '#e7e9ee', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.35)',
  black: '#1a1d24', brightBlack: '#646b77', blue: '#3b82f6', brightBlue: '#5b97f8', cyan: '#22d3ee', brightCyan: '#67e8f9',
  green: '#22c55e', brightGreen: '#4ade80', red: '#ef4444', brightRed: '#f87171', yellow: '#f59e0b', brightYellow: '#fbbf24',
  magenta: '#a78bfa', brightMagenta: '#c4b5fd', white: '#d4d7de', brightWhite: '#ffffff',
}

const HEIGHT_KEY = 'bcenter.terminalHeight'

/** Sessions transférées vers une fenêtre détachée : ne pas les fermer quand l'onglet disparaît d'ici. */
const handedOver = new Set<string>()

/**
 * Panneau du bas à onglets : terminaux SSH et gestionnaires de fichiers ouverts depuis Connexions.
 * Les onglets masqués restent connectés ; chaque onglet peut être détaché dans sa propre fenêtre.
 */
export function TerminalDock() {
  const { terminals, activeTerminal, terminalOpen, selectTerminal, closeTerminal, toggleTerminal, openShell, openFiles, updateTab } = useApp()
  const [states, setStates] = useState<Record<string, State>>({})
  const [height, setHeight] = useState(() => Number(localStorage.getItem(HEIGHT_KEY)) || 340)
  const [maximized, setMaximized] = useState(false)
  const [picker, setPicker] = useState(false)

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const move = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight - 160, Math.max(160, startHeight + startY - ev.clientY)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setHeight((h) => {
        localStorage.setItem(HEIGHT_KEY, String(h))
        return h
      })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const detach = async (tab: TerminalTab) => {
    if (tab.kind === 'shell' && tab.sessionId && states[tab.key] === 'open') handedOver.add(tab.sessionId)
    try {
      await api.openDetached({
        kind: tab.kind, targetId: tab.target.id, path: tab.path,
        sessionId: tab.kind === 'shell' && states[tab.key] === 'open' ? tab.sessionId : undefined,
      })
      closeTerminal(tab.key)
    } catch (e) {
      if (tab.sessionId) handedOver.delete(tab.sessionId)
      useApp.getState().toast('error', (e as Error).message)
    }
  }

  if (terminals.length === 0) return null
  const active = terminals.find((t) => t.key === activeTerminal)

  return (
    <div className="terminal-dock" style={{ height: maximized ? 'calc(100% - 110px)' : height, display: terminalOpen ? undefined : 'none' }}>
      {!maximized && <div className="resize" onMouseDown={startResize} />}
      <div className="tabs">
        {terminals.map((t) => (
          <div key={t.key} className={`tab${t.key === activeTerminal ? ' on' : ''}`} onClick={() => selectTerminal(t.key)} onAuxClick={(e) => e.button === 1 && closeTerminal(t.key)}>
            {t.kind === 'files'
              ? <FolderOpen size={13} style={{ color: 'var(--accent)' }} />
              : <span className={`dot ${states[t.key] === 'open' ? 'ok' : states[t.key] === 'error' ? 'bad' : states[t.key] === 'closed' ? '' : 'accent'}`} />}
            {t.target.name}
            <button aria-label="Fermer l’onglet" onClick={(e) => { e.stopPropagation(); closeTerminal(t.key) }}><X size={12} /></button>
          </div>
        ))}
        <div style={{ position: 'relative' }}>
          <button className="btn ghost sm icon" title="Nouvel onglet" onClick={() => setPicker((p) => !p)}><Plus size={14} /></button>
          {picker && <TargetPicker onShell={(t) => { setPicker(false); openShell(t) }} onFiles={(t) => { setPicker(false); openFiles(t) }} onClose={() => setPicker(false)} />}
        </div>
        <span style={{ flex: 1 }} />
        {active && <button className="btn ghost sm icon" title="Détacher dans une fenêtre séparée" onClick={() => void detach(active)}><ExternalLink size={13} /></button>}
        <button className="btn ghost sm icon" title={maximized ? 'Réduire' : 'Agrandir'} onClick={() => setMaximized((m) => !m)}>{maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        <button className="btn ghost sm icon" title="Masquer (les sessions restent ouvertes)" onClick={() => toggleTerminal(false)}><ChevronDown size={15} /></button>
      </div>
      <div className="panes">
        {terminals.map((t) => (
          <div key={t.key} className="pane" style={{ display: t.key === activeTerminal && terminalOpen ? undefined : 'none' }}>
            {t.kind === 'files'
              ? <FileBrowser target={t.target} onPath={(path) => updateTab(t.key, { path })} />
              : <TerminalPane target={t.target} active={t.key === activeTerminal && terminalOpen}
                  onSession={(sessionId) => updateTab(t.key, { sessionId })}
                  onState={(s) => setStates((prev) => (prev[t.key] === s ? prev : { ...prev, [t.key]: s }))} />}
          </div>
        ))}
      </div>
    </div>
  )
}

function TargetPicker({ onShell, onFiles, onClose }: { onShell: (t: SshTarget) => void; onFiles: (t: SshTarget) => void; onClose: () => void }) {
  const targets = useApp((s) => s.targets)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])
  return (
    <div ref={ref} className="menu-pop" style={{ top: 'auto', bottom: 34, maxHeight: 340, overflow: 'auto', minWidth: 300 }}>
      {targets.length === 0 && <div className="faint" style={{ padding: 8 }}>Aucune connexion enregistrée.</div>}
      {targets.map((t) => (
        <div key={t.id} className="row" style={{ alignItems: 'center', gap: 2 }}>
          <button style={{ flex: 1 }} onClick={() => onShell(t)}>
            <TerminalSquare size={14} style={{ color: 'var(--accent)' }} />
            {t.name}
            <span className="kbd">{t.group ?? t.host}</span>
          </button>
          <button style={{ width: 34, justifyContent: 'center' }} title="Fichiers" onClick={() => onFiles(t)}><FolderOpen size={14} /></button>
        </div>
      ))}
    </div>
  )
}

/** Terminal SSH : nouvelle session, ou reprise d'une session existante (fenêtre détachée). */
export function TerminalPane({ target, active, attachSession, onState, onSession }: {
  target: SshTarget
  active: boolean
  attachSession?: string
  onState?: (s: State) => void
  onSession?: (id: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [state, setState] = useState<State>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => onState?.(state), [state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const term = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: THEME })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    let id: string | null = null
    let disposed = false
    const refit = () => {
      if (!host.current?.offsetWidth) return
      fit.fit()
      if (id) void api.shellResize(id, term.cols, term.rows)
    }
    refit()

    // Les premières données peuvent arriver avant que l'identifiant de session ne soit connu.
    const early: { id: string; data: string }[] = []
    const offData = on('shellData', (e) => {
      if (id === null) early.push(e)
      else if (e.id === id) term.write(e.data)
    })
    const offExit = on('shellExit', (e) => {
      if (e.id !== id) return
      setState('closed')
      term.writeln('\r\n\x1b[90m[Session terminée]\x1b[0m')
    })

    const resume = attempt === 0 && attachSession
    const started = resume
      ? api.shellAttach(attachSession).then((buffer) => {
          term.write(buffer)
          return attachSession
        })
      : (term.writeln(`\x1b[90mConnexion SSH à ${target.host}:${target.port}…\x1b[0m`), api.openShell(target.id, term.cols, term.rows))
    started.then(
      (sessionId) => {
        if (disposed) {
          if (!handedOver.has(sessionId)) void api.shellClose(sessionId)
          return
        }
        id = sessionId
        onSession?.(sessionId)
        if (!resume) for (const e of early) if (e.id === id) term.write(e.data)
        setState('open')
        refit()
      },
      (e: Error) => {
        setState('error')
        term.writeln(`\x1b[31m${e.message}\x1b[0m`)
      },
    )

    const input = term.onData((data) => {
      if (id) void api.shellWrite(id, data)
    })
    const observer = new ResizeObserver(refit)
    observer.observe(host.current!)

    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      if (id && !handedOver.has(id)) void api.shellClose(id)
      term.dispose()
      termRef.current = null
    }
  }, [target.id, target.host, target.port, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div className="term-pane">
      {(state === 'closed' || state === 'error') && (
        <button className="btn sm reconnect" onClick={() => { setState('connecting'); setAttempt((n) => n + 1) }}><RefreshCw size={13} /> Reconnecter</button>
      )}
      <div className="xterm-host" ref={host} />
    </div>
  )
}
