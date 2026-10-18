import { AlertOctagon, AlertTriangle, Check, CheckCircle2, Info } from 'lucide-react'
import { Card, Empty, Stat, StatusBadge } from '../components/ui'
import { api } from '../lib/api'
import { relative } from '../lib/format'
import { useApp } from '../store'

export function AlertsPage() {
  const { alerts } = useApp()
  const count = (s: string) => alerts.active.filter((a) => a.severity === s).length

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Alertes</h1><p>Incidents détectés sur l’infrastructure</p></div>
        <div className="actions">
          <button className="btn" disabled={!alerts.active.some((a) => !a.acknowledged)} onClick={() => alerts.active.forEach((a) => void api.acknowledgeAlert(a.key))}>
            <Check size={14} /> Tout acquitter
          </button>
        </div>
      </div>
      <div className="grid three" style={{ marginBottom: 14 }}>
        <Stat label="Critiques" value={count('critical')} detail="Serveurs ou nœuds indisponibles" icon={<AlertOctagon size={18} />} color="var(--danger)" soft="var(--danger-soft)" />
        <Stat label="Avertissements" value={count('warning')} detail="Ressources sous tension" icon={<AlertTriangle size={18} />} color="var(--warning)" soft="var(--warning-soft)" />
        <Stat label="Informations" value={count('info')} detail="Redémarrages requis, etc." icon={<Info size={18} />} color="var(--info)" soft="var(--info-soft)" />
      </div>
      <div className="grid split">
        <Card title="Alertes actives" subtitle="Résolues automatiquement lorsque la condition disparaît">
          {alerts.active.length === 0 ? (
            <Empty icon={<CheckCircle2 size={24} />} title="Tout fonctionne normalement" message="Aucune alerte active pour le moment." />
          ) : (
            alerts.active.map((a) => (
              <div key={a.key} className="row" style={{ alignItems: 'center', padding: '12px 14px', borderRadius: 10, background: 'var(--panel-2)', marginBottom: 8, opacity: a.acknowledged ? 0.55 : 1 }}>
                <div style={{ width: 120 }}><StatusBadge status={a.severity} /></div>
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{a.title}</div>
                  <div className="muted">{a.message}</div>
                  <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{a.source} · {relative(a.raisedAt)}</div>
                </div>
                {!a.acknowledged && <button className="btn sm" onClick={() => void api.acknowledgeAlert(a.key)}>Acquitter</button>}
              </div>
            ))
          )}
        </Card>
        <Card title="Historique" subtitle="Alertes résolues pendant cette session" className="flush">
          {alerts.history.length === 0 ? <div className="faint" style={{ padding: 12 }}>Aucune alerte résolue.</div> : (
            <table className="table">
              <thead><tr><th>Niveau</th><th>Alerte</th><th>Source</th><th>Résolue</th></tr></thead>
              <tbody>
                {alerts.history.slice(0, 200).map((a) => (
                  <tr key={`${a.key}-${a.resolvedAt}`}>
                    <td><StatusBadge status={a.severity} /></td>
                    <td>{a.title}</td>
                    <td className="muted">{a.source}</td>
                    <td className="muted">{relative(a.resolvedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}
