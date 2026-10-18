import { Copy, FolderOpen, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { JobHistoryEntry } from '@shared/types'
import { Card, JobBadge, Segmented } from '../components/ui'
import { api } from '../lib/api'
import { clock, dateTime } from '../lib/format'
import { useApp } from '../store'

export function LogsPage() {
  const logs = useApp((s) => s.logs)
  const finished = useApp((s) => s.jobs.filter((j) => j.finishedAt).length)
  const [tab, setTab] = useState<'app' | 'jobs'>('app')
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all')
  const [query, setQuery] = useState('')
  const [history, setHistory] = useState<JobHistoryEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    void api.jobHistory().then((h) => {
      setHistory(h)
      setSelected((s) => s ?? h[0]?.id ?? null)
    })
  }, [finished, tab])

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    return logs
      .filter((l) => level === 'all' || (level === 'warn' ? l.level === 'warn' || l.level === 'error' : l.level === 'error'))
      .filter((l) => !q || l.message.toLowerCase().includes(q) || l.source.toLowerCase().includes(q))
      .slice()
      .reverse()
  }, [logs, level, query])
  const job = history.find((h) => h.id === selected)

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div><h1>Journaux</h1><p>Journal de l’application et historique de maintenance</p></div>
        <div className="actions">
          <Segmented value={tab} onChange={setTab} options={[['app', 'Journal de l’application'], ['jobs', 'Historique de maintenance']]} />
          <button className="btn" onClick={() => void api.openPath('logs')}><FolderOpen size={14} /> Dossier des journaux</button>
        </div>
      </div>

      {tab === 'app' ? (
        <div className="card flush" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="row" style={{ padding: 10, alignItems: 'center' }}>
            <label className="search" style={{ width: 320 }}><Search size={14} /><input placeholder="Rechercher dans le journal" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
            <span style={{ flex: 1 }} />
            <Segmented value={level} onChange={setLevel} options={[['all', 'Tout'], ['warn', 'Avertissements'], ['error', 'Erreurs']]} />
          </div>
          <div className="table-wrap" style={{ flex: 1 }}>
            <table className="table">
              <thead><tr><th style={{ width: 100 }}>Heure</th><th style={{ width: 90 }}>Niveau</th><th style={{ width: 160 }}>Source</th><th>Message</th></tr></thead>
              <tbody>
                {entries.map((l, i) => (
                  <tr key={i}>
                    <td className="mono faint">{clock(l.time)}</td>
                    <td className={`mono lv-${l.level === 'info' ? 'info' : l.level}`} style={{ fontWeight: 700 }}>{l.level.toUpperCase()}</td>
                    <td className="muted">{l.source}</td>
                    <td className="selectable">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(340px, 1fr) 1.6fr', flex: 1, minHeight: 0 }}>
          <Card title="Tâches exécutées" subtitle="Conservées dans la base locale">
            <div style={{ overflow: 'auto', maxHeight: 'calc(100vh - 330px)', margin: '0 -6px' }}>
              {history.length === 0 && <div className="faint" style={{ padding: '0 6px' }}>Aucune tâche enregistrée.</div>}
              {history.map((h) => (
                <div key={h.id} className={`list-item${h.id === selected ? ' selected' : ''}`} onClick={() => setSelected(h.id)}>
                  <div className="main"><div>{h.title}</div><div>{dateTime(h.queuedAt)} · {h.summary}</div></div>
                  <JobBadge status={h.status} />
                </div>
              ))}
            </div>
          </Card>
          <Card title="Journal de la tâche" subtitle={job?.title ?? 'Aucune tâche sélectionnée'}
            actions={<button className="btn ghost sm" disabled={!job} onClick={() => job && void navigator.clipboard.writeText(job.log)}><Copy size={13} /> Copier</button>}>
            <pre className="mono selectable" style={{ margin: 0, padding: 12, borderRadius: 9, background: 'var(--input)', border: '1px solid var(--border-soft)', overflow: 'auto', maxHeight: 'calc(100vh - 330px)', whiteSpace: 'pre-wrap' }}>
              {job?.log ?? ''}
            </pre>
          </Card>
        </div>
      )}
    </div>
  )
}
