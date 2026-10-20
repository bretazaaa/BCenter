import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { ChevronDown, Maximize2, Minimize2, Plus, RefreshCw, TerminalSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SshTarget } from '@shared/types'
import { api, on } from '../lib/api'
import { useApp } from '../store'

type State = 'connecting' | 'open' | 'closed' | 'error'

const THEME = {
  background: '#08090c', foreground: '#e7e9ee', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.35)',
  black: '#1a1d24', brightBlack: '#646b77', blue: '#3b82f6', brightBlue: '#5b97f8', cyan: '#22d3ee', brightCyan: '#67e8f9',
  green: '#22c55e', brightGreen: '#4ade80', red: '#ef4444', brightRed: '#f87171', yellow: '#f59e0b', brightYellow: '#fbbf24',
  magenta: '#a78bfa', brightMagenta: '#c4b5fd', white: '#d4d7de', brightWhite: '#ffffff',
}

const HEIGHT_KEY = 'bcenter.terminalHeight'

/**
 * Terminal central à onglets : toutes les sessions SSH ouvertes depuis BCenter (Connexions, VM / LXC, NAS,
 * mises à jour). Les onglets masqués restent connectés ; Échap n'est pas intercepté (vim, less…).
 */
export function TerminalDock() {
  const { terminals, activeTerminal, terminalOpen, selectTerminal, closeTerminal, toggleTerminal, openShell } = useApp()
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

  if (terminals.length === 0) return null

  return (
    <div className="terminal-dock" style={{ height: maximized ? 'calc(100% - 110px)' : height, display: terminalOpen ? undefined : 'none' }}>
      {!maximized && <div className="resize" onMouseDown={startResize} />}
      <div className="tabs">
        {terminals.map((t) => (
          <div key={t.key} className={`tab${t.key === activeTerminal ? ' on' : ''}`} onClick={() => selectTerminal(t.key)} onAuxClick={(e) => e.button === 1 && closeTerminal(t.key)}>
            <span className={`dot ${states[t.key] === 'open' ? 'ok' : states[t.key] === 'error' ? 'bad' : states[t.key] === 'closed' ? '' : 'accent'}`} />
            {t.target.name}
            <button aria-label="Fermer l’onglet" onClick={(e) => { e.stopPropagation(); closeTerminal(t.key) }}><X size={12} /></button>
          </div>
        ))}
        <div style={{ position: 'relative' }}>
          <button className="btn ghost sm icon" title="Nouvel onglet" onClick={() => setPicker((p) => !p)}><Plus size={14} /></button>
          {picker && <TargetPicker onPick={(t) => { setPicker(false); openShell(t) }} onClose={() => setPicker(false)} />}
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm icon" title={maximized ? 'Réduire' : 'Agrandir'} onClick={() => setMaximized((m) => !m)}>{maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
        <button className="btn ghost sm icon" title="Masquer le terminal (les sessions restent ouvertes)" onClick={() => toggleTerminal(false)}><ChevronDown size={15} /></button>
      </div>
      <div className="panes">
        {terminals.map((t) => (
          <TerminalPane key={t.key} target={t.target} active={t.key === activeTerminal && terminalOpen}
            onState={(s) => setStates((prev) => (prev[t.key] === s ? prev : { ...prev, [t.key]: s }))} />
        ))}
      </div>
    </div>
  )
}

function TargetPicker({ onPick, onClose }: { onPick: (t: SshTarget) => void; onClose: () => void }) {
  const targets = useApp((s) => s.targets)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [onClose])
  return (
    <div ref={ref} className="menu-pop" style={{ top: 'auto', bottom: 34, maxHeight: 320, overflow: 'auto' }}>
      {targets.length === 0 && <div className="faint" style={{ padding: 8 }}>Aucune connexion enregistrée.</div>}
      {targets.map((t) => (
        <button key={t.id} onClick={() => onPick(t)}>
          <TerminalSquare size={14} style={{ color: 'var(--accent)' }} />
          {t.name}
          <span className="kbd">{t.group ?? t.host}</span>
        </button>
      ))}
    </div>
  )
}

function TerminalPane({ target, active, onState }: { target: SshTarget; active: boolean; onState: (s: State) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const [state, setState] = useState<State>('connecting')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => onState(state), [state]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const term = new Terminal({ fontFamily: "'Cascadia Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.15, cursorBlink: true, scrollback: 5000, theme: THEME })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    let id: string | null = null
    const refit = () => {
      if (!host.current?.offsetWidth) return
      fit.fit()
      if (id) void api.shellResize(id, term.cols, term.rows)
    }
    refit()
    term.writeln(`\x1b[90mConnexion SSH à ${target.host}:${target.port}…\x1b[0m`)

    let disposed = false
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

    api.openShell(target.id, term.cols, term.rows).then(
      (sessionId) => {
        if (disposed) return void api.shellClose(sessionId)
        id = sessionId
        for (const e of early) if (e.id === id) term.write(e.data)
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
      if (id) void api.shellClose(id)
      term.dispose()
      termRef.current = null
    }
  }, [target.id, target.host, target.port, attempt])

  useEffect(() => {
    if (active) termRef.current?.focus()
  }, [active])

  return (
    <div className="pane" style={{ display: active ? undefined : 'none' }}>
      {(state === 'closed' || state === 'error') && (
        <button className="btn sm reconnect" onClick={() => { setState('connecting'); setAttempt((n) => n + 1) }}><RefreshCw size={13} /> Reconnecter</button>
      )}
      <div className="xterm-host" ref={host} />
    </div>
  )
}
