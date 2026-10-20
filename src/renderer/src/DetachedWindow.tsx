import { Copy, FolderOpen, Minus, Square, TerminalSquare, Undo2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DetachSpec, SshTarget } from '@shared/types'
import { DialogHost } from './components/dialogs'
import { FileBrowser } from './components/FileBrowser'
import { Toasts } from './components/shell'
import { TerminalPane } from './components/Terminal'
import { api, isWeb, on } from './lib/api'

/** Fenêtre séparée : un terminal (session reprise depuis la fenêtre principale) ou un gestionnaire de fichiers. */
export function DetachedWindow({ spec }: { spec: DetachSpec }) {
  const [target, setTarget] = useState<SshTarget | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)
  const [sessionId, setSessionId] = useState(spec.sessionId)
  const [path, setPath] = useState(spec.path)
  const reattach = () => void api.reattach({ ...spec, sessionId: spec.kind === 'shell' ? sessionId : undefined, path })

  useEffect(() => {
    api.listTargets().then(
      (targets) => {
        const t = targets.find((x) => x.id === spec.targetId)
        if (t) setTarget(t)
        else setError('Cette connexion n’existe plus.')
      },
      (e: Error) => setError(e.message),
    )
    return on('maximized', setMaximized)
  }, [spec.targetId])

  useEffect(() => {
    if (target) document.title = `${target.name} — ${spec.kind === 'files' ? 'Fichiers' : 'Terminal'} · BCenter`
  }, [target, spec.kind])

  return (
    <div className="shell">
      <header className="titlebar" onDoubleClick={(e) => e.target === e.currentTarget && void api.windowToggleMaximize()}>
        <div className="brand">
          {spec.kind === 'files' ? <FolderOpen size={16} color="var(--accent)" /> : <TerminalSquare size={16} color="var(--accent)" />}
          {target?.name ?? '…'}
          <span className="faint mono" style={{ fontWeight: 400, marginLeft: 6 }}>{target ? `${target.host}:${target.port}` : ''}</span>
        </div>
        <div className="spacer" />
        {target && !isWeb() && <button className="btn ghost sm" style={{ marginRight: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties} title="Ramener dans la fenêtre principale de BCenter" onClick={reattach}><Undo2 size={13} /> Rattacher</button>}
        {!isWeb() && <div className="winctl">
          <button onClick={() => void api.windowMinimize()} aria-label="Réduire"><Minus size={15} /></button>
          <button onClick={() => void api.windowToggleMaximize()} aria-label="Agrandir">{maximized ? <Copy size={12} /> : <Square size={12} />}</button>
          <button className="close" onClick={() => void api.windowClose()} aria-label="Fermer"><X size={16} /></button>
        </div>}
      </header>
      <main className="content" style={{ position: 'relative' }}>
        {error && <div className="error" style={{ padding: 20 }}>{error}</div>}
        {target && (spec.kind === 'files'
          ? <FileBrowser target={target} initialPath={spec.path} onPath={setPath} />
          : <TerminalPane target={target} active attachSession={spec.sessionId} onSession={setSessionId} onState={(s) => s !== 'open' && s !== 'connecting' && setSessionId(undefined)} />)}
      </main>
      <Toasts />
      <DialogHost />
    </div>
  )
}
