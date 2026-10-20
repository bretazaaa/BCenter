import {
  ArrowUp, Download, File, FileText, Folder, FolderPlus, FolderUp, Home, Link as LinkIcon, Pencil, RefreshCw, Save, Search, Trash2, Upload,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteFile, SshTarget } from '@shared/types'
import { api, on } from '../lib/api'
import { bytes, dateTime } from '../lib/format'
import { useApp } from '../store'
import { confirm, useAction } from './dialogs'
import { Field, Modal, Progress } from './ui'

const parentOf = (path: string) => (path === '/' ? '/' : path.replace(/\/[^/]+\/?$/, '') || '/')
const joinPath = (dir: string, name: string) => (dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`)
const toast = (kind: 'success' | 'error' | 'info', text: string) => useApp.getState().toast(kind, text)

/**
 * Gestionnaire de fichiers distant (SFTP) : navigation, envoi (bouton ou glisser-déposer depuis l'Explorateur),
 * téléchargement, création, renommage, suppression et édition des fichiers texte.
 */
export function FileBrowser({ target, initialPath, onPath }: { target: SshTarget; initialPath?: string; onPath?: (path: string) => void }) {
  const [fsId, setFsId] = useState<string | null>(null)
  const [path, setPath] = useState(initialPath ?? '')
  const [input, setInput] = useState(initialPath ?? '')
  const [entries, setEntries] = useState<RemoteFile[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [transfer, setTransfer] = useState<{ file: string; transferred: number; total: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [prompt, setPrompt] = useState<{ title: string; label: string; value: string; onSubmit: (v: string) => Promise<void> } | null>(null)
  const [editing, setEditing] = useState<{ path: string; content: string } | null>(null)
  const homeRef = useRef('/')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let id: string | null = null
    let disposed = false
    setLoading(true)
    setError(null)
    api.fsOpen(target.id).then(
      (session) => {
        if (disposed) return void api.fsClose(session.id)
        id = session.id
        homeRef.current = session.home
        setFsId(session.id)
        setPath((p) => p || session.home)
      },
      (e: Error) => {
        setError(e.message)
        setLoading(false)
      },
    )
    return () => {
      disposed = true
      if (id) void api.fsClose(id)
    }
  }, [target.id, attempt])

  const load = useCallback(async (dir: string) => {
    if (!fsId) return
    setLoading(true)
    try {
      setEntries(await api.fsList(fsId, dir))
      setSelected(new Set())
      setError(null)
      setInput(dir)
      onPath?.(dir)
    } catch (e) {
      toast('error', (e as Error).message)
      setInput(path)
    } finally {
      setLoading(false)
    }
  }, [fsId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (fsId && path) void load(path)
  }, [fsId, path, load])

  useEffect(() => on('fsProgress', (p) => {
    if (p.id !== fsId) return
    setTransfer(p.transferred >= p.total ? null : p)
  }), [fsId])

  const go = (dir: string) => (dir === path ? void load(dir) : setPath(dir))
  const shown = useMemo(() => entries.filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase())), [entries, filter])
  const chosen = entries.filter((e) => selected.has(e.path))

  const run = async (action: () => Promise<unknown>, success?: string) => {
    try {
      await action()
      if (success) toast('success', success)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setTransfer(null)
      void load(path)
    }
  }

  const open = async (entry: RemoteFile) => {
    if (entry.type === 'dir') return go(entry.path)
    try {
      setEditing({ path: entry.path, content: await api.fsReadText(fsId!, entry.path) })
    } catch (e) {
      toast('info', (e as Error).message)
    }
  }

  const download = async (items = chosen) => {
    if (!items.length) return
    try {
      const local = await api.fsDownload(fsId!, items.map((e) => e.path))
      if (local) toast('success', `Téléchargé dans ${local}`)
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setTransfer(null)
    }
  }

  const remove = async () => {
    if (!chosen.length) return
    const ok = await confirm({
      title: 'Supprimer', danger: true, confirmText: 'Supprimer',
      message: `Supprimer définitivement ${chosen.length} élément(s) sur ${target.name} ? Les dossiers sont supprimés avec tout leur contenu.`,
      details: chosen.map((e) => e.path).join('\n'),
    })
    if (ok) await run(() => api.fsDelete(fsId!, chosen.map((e) => e.path)), 'Supprimé.')
  }

  const rename = (entry: RemoteFile) =>
    setPrompt({ title: 'Renommer', label: 'Nouveau nom', value: entry.name, onSubmit: (name) => run(() => api.fsRename(fsId!, entry.path, joinPath(parentOf(entry.path), name))) })

  const newFolder = () =>
    setPrompt({ title: 'Nouveau dossier', label: 'Nom du dossier', value: '', onSubmit: (name) => run(() => api.fsMkdir(fsId!, joinPath(path, name))) })

  const newFile = () =>
    setPrompt({ title: 'Nouveau fichier', label: 'Nom du fichier', value: '', onSubmit: async (name) => {
      await run(() => api.fsWriteText(fsId!, joinPath(path, name), ''))
      setEditing({ path: joinPath(path, name), content: '' })
    } })

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const paths = [...e.dataTransfer.files].map((f) => window.bcenter.pathForFile(f)).filter(Boolean)
    if (paths.length && fsId) await run(() => api.fsUploadPaths(fsId, path, paths), `${paths.length} élément(s) envoyé(s).`)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if (e.key === 'Delete') void remove()
    else if (e.key === 'F2' && chosen.length === 1) rename(chosen[0])
    else if (e.key === 'Backspace') go(parentOf(path))
    else if (e.key === 'Enter' && chosen.length === 1) void open(chosen[0])
    else if (e.key.toLowerCase() === 'a' && e.ctrlKey) {
      e.preventDefault()
      setSelected(new Set(shown.map((x) => x.path)))
    }
  }

  const click = (e: React.MouseEvent, entry: RemoteFile) => {
    setSelected((s) => {
      if (e.ctrlKey) {
        const next = new Set(s)
        if (next.has(entry.path)) next.delete(entry.path)
        else next.add(entry.path)
        return next
      }
      if (e.shiftKey && s.size) {
        const last = shown.findIndex((x) => s.has(x.path))
        const current = shown.indexOf(entry)
        const [a, b] = last < current ? [last, current] : [current, last]
        return new Set(shown.slice(a, b + 1).map((x) => x.path))
      }
      return new Set([entry.path])
    })
  }

  if (error && !fsId) {
    return (
      <div className="file-browser" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="error" style={{ marginBottom: 10 }}>{error}</div>
          <button className="btn sm" onClick={() => setAttempt((n) => n + 1)}><RefreshCw size={13} /> Réessayer</button>
        </div>
      </div>
    )
  }

  const crumbs = path.split('/').filter(Boolean)
  return (
    <div className="file-browser" tabIndex={0} onKeyDown={onKey}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)} onDrop={(e) => void onDrop(e)}>
      <div className="fb-toolbar">
        <button className="btn ghost sm icon" title="Dossier parent (Retour arrière)" onClick={() => go(parentOf(path))}><ArrowUp size={14} /></button>
        <button className="btn ghost sm icon" title="Dossier personnel" onClick={() => go(homeRef.current)}><Home size={14} /></button>
        <button className="btn ghost sm icon" title="Actualiser" onClick={() => void load(path)}><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
        <form className="fb-path" onSubmit={(e) => { e.preventDefault(); go(input.trim() || '/') }}>
          <input className="input mono" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
        </form>
        <label className="search" style={{ width: 170, height: 30 }}>
          <Search size={13} />
          <input placeholder="Filtrer" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </label>
        <span className="sep" />
        <button className="btn ghost sm icon" title="Nouveau dossier" onClick={newFolder}><FolderPlus size={14} /></button>
        <button className="btn ghost sm icon" title="Nouveau fichier" onClick={newFile}><FileText size={14} /></button>
        <button className="btn ghost sm icon" title="Envoyer des fichiers (ou glissez-les ici)" onClick={() => void run(() => api.fsUpload(fsId!, path, false))}><Upload size={14} /></button>
        <button className="btn ghost sm icon" title="Envoyer un dossier" onClick={() => void run(() => api.fsUpload(fsId!, path, true))}><FolderUp size={14} /></button>
        <button className="btn ghost sm icon" title="Télécharger la sélection" disabled={!chosen.length} onClick={() => void download()}><Download size={14} /></button>
        <button className="btn ghost sm icon" title="Renommer (F2)" disabled={chosen.length !== 1} onClick={() => rename(chosen[0])}><Pencil size={14} /></button>
        <button className="btn ghost sm icon" title="Supprimer (Suppr)" disabled={!chosen.length} onClick={() => void remove()}><Trash2 size={14} /></button>
      </div>
      <div className="fb-crumbs">
        <button onClick={() => go('/')}>/</button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <button onClick={() => go(`/${crumbs.slice(0, i + 1).join('/')}`)}>{c}</button>
            {i < crumbs.length - 1 && <span className="faint">/</span>}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <span className="faint">{entries.length} élément(s){chosen.length ? ` · ${chosen.length} sélectionné(s)` : ''}</span>
      </div>
      {transfer && (
        <div className="fb-transfer">
          <span className="mono">{transfer.file}</span>
          <div className="grow"><Progress value={transfer.total ? transfer.transferred / transfer.total : 0} /></div>
          <span className="faint">{bytes(transfer.transferred)} / {bytes(transfer.total)}</span>
        </div>
      )}
      <div className="fb-list">
        <table className="table">
          <thead><tr><th>Nom</th><th style={{ width: 110 }}>Taille</th><th style={{ width: 160 }}>Modifié</th><th style={{ width: 120 }}>Droits</th></tr></thead>
          <tbody>
            {path !== '/' && (
              <tr className="fb-row" onDoubleClick={() => go(parentOf(path))}>
                <td colSpan={4}><Folder size={14} className="fb-icon dir" /> ..</td>
              </tr>
            )}
            {shown.map((e) => (
              <tr key={e.path} className={`fb-row${selected.has(e.path) ? ' on' : ''}`} onClick={(ev) => click(ev, e)} onDoubleClick={() => void open(e)}
                draggable={false}>
                <td>
                  {e.type === 'dir' ? <Folder size={14} className="fb-icon dir" /> : e.type === 'link' ? <LinkIcon size={14} className="fb-icon" /> : <File size={14} className="fb-icon" />}
                  {e.name}
                </td>
                <td className="muted">{e.type === 'dir' ? '' : bytes(e.size)}</td>
                <td className="muted">{dateTime(e.modified)}</td>
                <td className="mono faint">{e.mode}</td>
              </tr>
            ))}
            {!loading && shown.length === 0 && <tr><td colSpan={4} className="faint">{filter ? 'Aucun élément ne correspond.' : 'Dossier vide.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {dragging && <div className="fb-drop">Déposez pour envoyer dans <span className="mono">{path}</span></div>}
      {prompt && <PromptModal {...prompt} onClose={() => setPrompt(null)} />}
      {editing && fsId && <EditorModal fsId={fsId} host={target.name} file={editing} onClose={() => { setEditing(null); void load(path) }} />}
    </div>
  )
}

function PromptModal({ title, label, value, onSubmit, onClose }: { title: string; label: string; value: string; onSubmit: (v: string) => Promise<void>; onClose: () => void }) {
  const [text, setText] = useState(value)
  const valid = !!text.trim() && !text.includes('/')
  const submit = async () => {
    if (!valid) return
    onClose()
    await onSubmit(text.trim())
  }
  return (
    <Modal title={title} width={440} onClose={onClose}
      footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" disabled={!valid} onClick={() => void submit()}>Valider</button></>}>
      <Field label={label}>
        <input className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
    </Modal>
  )
}

/** Éditeur de fichier texte distant (2 Mio au plus). */
function EditorModal({ fsId, host, file, onClose }: { fsId: string; host: string; file: { path: string; content: string }; onClose: () => void }) {
  const [content, setContent] = useState(file.content)
  const dirty = content !== file.content
  const { busy, error, run } = useAction()
  const save = () => run(async () => {
    await api.fsWriteText(fsId, file.path, content)
    toast('success', `${file.path} enregistré.`)
    onClose()
  })
  const close = async () => {
    if (!dirty || (await confirm({ title: 'Modifications non enregistrées', confirmText: 'Fermer sans enregistrer', danger: true, message: 'Fermer l’éditeur et perdre les modifications ?' }))) onClose()
  }
  return (
    <Modal title={<span>{file.path} <span className="faint" style={{ fontWeight: 400, marginLeft: 8 }}>{host}</span></span>} width={980} onClose={() => void close()}
      footer={<><span className="error">{error}</span><span className="faint" style={{ fontSize: 12 }}>Ctrl+S pour enregistrer</span><button className="btn" onClick={() => void close()}>Fermer</button><button className="btn primary" disabled={!dirty || busy} onClick={() => void save()}><Save size={14} /> Enregistrer</button></>}>
      <textarea className="input mono fb-editor" spellCheck={false} value={content} autoFocus
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.ctrlKey && e.key.toLowerCase() === 's') {
            e.preventDefault()
            if (dirty) void save()
          } else if (e.key === 'Tab') {
            e.preventDefault()
            const el = e.currentTarget
            const { selectionStart: s, selectionEnd: end } = el
            setContent(content.slice(0, s) + '  ' + content.slice(end))
            requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2))
          }
        }} />
    </Modal>
  )
}
