import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { RefreshCw, TerminalSquare, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { SshTarget } from '@shared/types'
import { api, on } from '../lib/api'
import { Badge } from './ui'

type State = 'connecting' | 'open' | 'closed' | 'error'

/**
 * Terminal SSH interactif vers une machine du centre de mises à jour.
 * Fenêtre dédiée sans fermeture par Échap, pour laisser les raccourcis au terminal (vim, less…).
 */
export function ShellWindow({ target, onClose }: { target: SshTarget; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<State>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: {
        background: '#08090c', foreground: '#e7e9ee', cursor: '#3b82f6', selectionBackground: 'rgba(59,130,246,0.35)',
        black: '#1a1d24', brightBlack: '#646b77', blue: '#3b82f6', brightBlue: '#5b97f8', cyan: '#22d3ee', brightCyan: '#67e8f9',
        green: '#22c55e', brightGreen: '#4ade80', red: '#ef4444', brightRed: '#f87171', yellow: '#f59e0b', brightYellow: '#fbbf24',
        magenta: '#a78bfa', brightMagenta: '#c4b5fd', white: '#d4d7de', brightWhite: '#ffffff',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    fit.fit()
    term.writeln(`\x1b[90mConnexion SSH à ${target.host}:${target.port}…\x1b[0m`)

    let id: string | null = null
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
        if (disposed) {
          void api.shellClose(sessionId)
          return
        }
        id = sessionId
        for (const e of early) if (e.id === id) term.write(e.data)
        setState('open')
        term.focus()
      },
      (e: Error) => {
        setState('error')
        setError(e.message)
        term.writeln(`\x1b[31m${e.message}\x1b[0m`)
      },
    )

    const input = term.onData((data) => {
      if (id) void api.shellWrite(id, data)
    })
    const observer = new ResizeObserver(() => {
      fit.fit()
      if (id) void api.shellResize(id, term.cols, term.rows)
    })
    observer.observe(host.current!)

    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      offData()
      offExit()
      if (id) void api.shellClose(id)
      term.dispose()
    }
  }, [target.id, target.host, target.port, attempt])

  return (
    <div className="overlay">
      <div className="modal shell-window">
        <div className="m-head">
          <TerminalSquare size={15} style={{ marginRight: 8, color: 'var(--accent)' }} />
          Shell — {target.name}
          <span className="faint mono" style={{ marginLeft: 10, fontWeight: 400 }}>{target.host}:{target.port}</span>
          <span style={{ marginLeft: 12 }}>
            {state === 'connecting' && <Badge kind="info">Connexion…</Badge>}
            {state === 'open' && <Badge kind="success">Connecté</Badge>}
            {state === 'closed' && <Badge>Terminé</Badge>}
            {state === 'error' && <Badge kind="danger">Échec</Badge>}
          </span>
          <span style={{ flex: 1 }} />
          {(state === 'closed' || state === 'error') && (
            <button className="btn sm" style={{ marginRight: 6 }} onClick={() => { setError(null); setState('connecting'); setAttempt((n) => n + 1) }}>
              <RefreshCw size={13} /> Reconnecter
            </button>
          )}
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Fermer le shell"><X size={15} /></button>
        </div>
        <div className="shell-body" ref={host} title={error ?? undefined} />
      </div>
    </div>
  )
}
