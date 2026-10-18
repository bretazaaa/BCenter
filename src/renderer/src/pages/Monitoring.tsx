import { Activity } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MetricPoint, MetricTimeframe } from '@shared/types'
import { TimeChart } from '../components/charts'
import { Card, Empty, Progress, Segmented } from '../components/ui'
import { api } from '../lib/api'
import { bytes, pct, rate } from '../lib/format'
import { useApp } from '../store'

interface Target { key: string; label: string; serverId: string; node: string; guest: { kind: string; vmid: number } | null }

const TIME_FORMATS: Record<MetricTimeframe, Intl.DateTimeFormatOptions> = {
  hour: { hour: '2-digit', minute: '2-digit' },
  day: { hour: '2-digit', minute: '2-digit' },
  week: { weekday: 'short', hour: '2-digit' },
  month: { day: '2-digit', month: '2-digit' },
}

export function MonitoringPage() {
  const infra = useApp((s) => s.infra)
  const targets = useMemo<Target[]>(
    () =>
      infra.snapshots.filter((s) => s.reachable).flatMap((s) => [
        ...s.nodes.filter((n) => n.status === 'online').map((n) => ({ key: `${s.server.id}/node/${n.name}`, label: `Nœud ${n.name} — ${s.server.name}`, serverId: s.server.id, node: n.name, guest: null })),
        ...s.guests.filter((g) => !g.template).map((g) => ({
          key: `${s.server.id}/guest/${g.vmid}`, label: `${g.vmid} · ${g.name} (${g.kind === 'lxc' ? 'LXC' : 'VM'})`, serverId: s.server.id, node: g.node, guest: { kind: g.kind, vmid: g.vmid },
        })),
      ]),
    [infra],
  )
  const [key, setKey] = useState<string>('')
  const [timeframe, setTimeframe] = useState<MetricTimeframe>('hour')
  const [points, setPoints] = useState<MetricPoint[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const target = targets.find((t) => t.key === key) ?? targets[0]

  useEffect(() => {
    if (!target) return
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const data = await api.getMetrics(target.serverId, target.node, target.guest, timeframe)
        if (!cancelled) {
          setPoints(data)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    const timer = timeframe === 'hour' ? setInterval(load, 60_000) : undefined
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [target?.key, timeframe]) // eslint-disable-line react-hooks/exhaustive-deps

  if (targets.length === 0) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty icon={<Activity size={24} />} title="Aucune ressource à surveiller" message="Les métriques apparaîtront dès qu’un serveur Proxmox sera connecté." />
      </div>
    )
  }

  const data = points.map((p) => ({
    time: p.time, cpu: (p.cpu ?? 0) * 100, mem: p.memUsed, netIn: p.netIn, netOut: p.netOut, load: p.loadAvg, io: p.ioWait != null ? p.ioWait * 100 : undefined,
  }))
  const cpus = points.map((p) => p.cpu ?? 0)
  const last = points[points.length - 1]
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const fmt = TIME_FORMATS[timeframe]

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Monitoring</h1><p>Historique des performances (données RRD de Proxmox)</p></div>
        <div className="actions">
          {loading && <div style={{ width: 80 }}><Progress indeterminate /></div>}
          <select className="select" style={{ width: 380 }} value={target?.key} onChange={(e) => setKey(e.target.value)}>
            {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <Segmented value={timeframe} onChange={setTimeframe} options={[['hour', '1 heure'], ['day', '24 heures'], ['week', '7 jours'], ['month', '30 jours']]} />
        </div>
      </div>
      {error && <div className="callout danger" style={{ marginBottom: 14 }}>Métriques indisponibles : {error}</div>}

      <div className="grid halves">
        <Card title="Processeur" subtitle={points.length ? `Moyenne ${pct(avg(cpus))} · pic ${pct(Math.max(...cpus))}` : '—'}>
          <TimeChart data={data} height={230} domain={[0, 100]} timeFormat={fmt} format={(v) => `${Math.round(v)} %`} series={[{ key: 'cpu', name: 'Processeur', color: '#3b82f6' }]} />
        </Card>
        <Card title="Mémoire" subtitle={last ? `${bytes(last.memUsed)}${last.memTotal ? ` / ${bytes(last.memTotal)}` : ''}` : '—'}>
          <TimeChart data={data} height={230} timeFormat={fmt} format={bytes} series={[{ key: 'mem', name: 'Mémoire utilisée', color: '#22d3ee' }]} />
        </Card>
        <Card title="Réseau" subtitle={points.length ? `↓ ${rate(avg(points.map((p) => p.netIn ?? 0)))}  ↑ ${rate(avg(points.map((p) => p.netOut ?? 0)))} (moyenne)` : '—'}>
          <TimeChart data={data} height={230} timeFormat={fmt} format={rate} legend
            series={[{ key: 'netIn', name: 'Entrant', color: '#a78bfa' }, { key: 'netOut', name: 'Sortant', color: '#22c55e', fill: false }]} />
        </Card>
        <Card title="Charge système" subtitle={last?.loadAvg != null ? `Charge actuelle ${last.loadAvg.toFixed(2)}` : 'Non disponible pour un invité'}>
          <TimeChart data={data} height={230} timeFormat={fmt} format={(v) => v.toFixed(1)} legend
            series={[{ key: 'load', name: 'Charge', color: '#f59e0b' }, { key: 'io', name: 'Attente E/S (%)', color: '#22d3ee', fill: false }]} />
        </Card>
      </div>
    </div>
  )
}
