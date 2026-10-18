import { AlertTriangle, Box, CheckCircle2, Monitor, Network, Server, Wrench } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { RemoteTask } from '@shared/types'
import { TimeChart } from '../components/charts'
import { Badge, Card, Empty, Stat, StatusBadge, Usage, type BadgeKind } from '../components/ui'
import { api } from '../lib/api'
import { bytes, pct, rate, relative, uptime } from '../lib/format'
import { useApp } from '../store'

const TASK_LABELS: Record<string, string> = {
  vzdump: 'Sauvegarde', qmstart: 'Démarrage', vzstart: 'Démarrage', qmshutdown: 'Arrêt', vzshutdown: 'Arrêt',
  qmstop: 'Arrêt forcé', vzstop: 'Arrêt forcé', qmreboot: 'Redémarrage', vzreboot: 'Redémarrage', qmigrate: 'Migration',
  vzmigrate: 'Migration', qmclone: 'Clonage', vzclone: 'Clonage', qmsnapshot: 'Snapshot', vzsnapshot: 'Snapshot', qmrollback: 'Restauration de snapshot',
  aptupdate: 'Mise à jour des index',
}

export function Dashboard() {
  const { infra, alerts, scans, jobs, navigate } = useApp()
  const [tasks, setTasks] = useState<(RemoteTask & { serverName: string })[]>([])

  useEffect(() => {
    const load = () => void api.getRecentTasks().then(setTasks).catch(() => undefined)
    load()
    const timer = setInterval(load, 60_000)
    return () => clearInterval(timer)
  }, [])

  const data = useMemo(() => {
    const nodes = infra.snapshots.flatMap((s) => s.nodes)
    const online = nodes.filter((n) => n.status === 'online')
    const guests = infra.snapshots.flatMap((s) => s.guests).filter((g) => !g.template)
    const vms = guests.filter((g) => g.kind === 'qemu')
    const lxc = guests.filter((g) => g.kind === 'lxc')
    const cpus = online.reduce((s, n) => s + n.cpuCount, 0)
    const memTotal = online.reduce((s, n) => s + n.memTotal, 0)
    const memUsed = online.reduce((s, n) => s + n.memUsed, 0)
    const storages = [...new Map(
      infra.snapshots.flatMap((s) => s.storages).filter((s) => s.active && s.total > 0)
        .map((s) => [s.shared ? `${s.serverId}/${s.name}` : `${s.serverId}/${s.node}/${s.name}`, s]),
    ).values()]
    const stTotal = storages.reduce((s, x) => s + x.total, 0)
    const stUsed = storages.reduce((s, x) => s + x.used, 0)
    const scanList = Object.values(scans).filter((s) => s.system)
    const names = new Map(infra.servers.map((s) => [s.id, s.name]))
    return {
      nodes, online, vms, lxc, cpus, memTotal, memUsed, stTotal, stUsed, names,
      cpu: cpus ? online.reduce((s, n) => s + n.cpu * n.cpuCount, 0) / cpus : 0,
      packages: scanList.reduce((n, s) => n + s.packages.length, 0),
      security: scanList.reduce((n, s) => n + s.packages.filter((p) => p.security).length, 0),
      reboots: scanList.filter((s) => s.rebootRequired).length,
      scanned: scanList.length,
      top: guests.filter((g) => g.status === 'running').sort((a, b) => b.cpu - a.cpu).slice(0, 6),
    }
  }, [infra, scans])

  const history = infra.history.map((h) => ({ time: h.time, cpu: h.cpu * 100, mem: h.mem * 100 }))
  const lastNet = [...infra.history].reverse().find((h) => Number.isFinite(h.netIn))

  const activity = useMemo(() => {
    const local = jobs.filter((j) => j.finishedAt).slice(0, 8).map((j) => ({
      time: j.finishedAt!, title: j.title, detail: j.summary ?? '', kind: (j.status === 'succeeded' ? 'success' : j.status === 'failed' ? 'danger' : 'warning') as BadgeKind,
      label: j.status === 'succeeded' ? 'OK' : j.status === 'failed' ? 'Échec' : 'Annulée', icon: <Wrench size={14} />,
    }))
    const remote = tasks.map((t) => ({
      time: t.startedAt, title: `${TASK_LABELS[t.type] ?? t.type}${t.objectId ? ` ${t.objectId}` : ''}`, detail: `${t.serverName} / ${t.node}${t.user ? ` · ${t.user}` : ''}`,
      kind: (t.state === 'ok' ? 'success' : t.state === 'running' ? 'accent' : 'danger') as BadgeKind,
      label: t.state === 'ok' ? 'OK' : t.state === 'running' ? 'En cours' : 'Échec', icon: <Server size={14} />,
    }))
    return [...local, ...remote].sort((a, b) => b.time - a.time).slice(0, 8)
  }, [jobs, tasks])

  if (infra.servers.length === 0) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty icon={<Network size={24} />} title="Aucun serveur Proxmox configuré" message="Ajoutez un serveur Proxmox VE pour afficher l’état de votre infrastructure.">
          <button className="btn primary" onClick={() => navigate('settings')}>Ajouter un serveur</button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Tableau de bord</h1>
          <p>Vue d’ensemble de votre infrastructure</p>
        </div>
      </div>

      <div className="grid kpi">
        <Stat label="Nœuds en ligne" value={`${data.online.length} / ${data.nodes.length}`} icon={<Server size={18} />}
          detail={data.online.length === data.nodes.length ? 'Tous les nœuds sont en ligne' : `${data.nodes.length - data.online.length} hors ligne`} onClick={() => navigate('infrastructure')} />
        <Stat label="Machines virtuelles" value={`${data.vms.filter((g) => g.status === 'running').length} / ${data.vms.length}`} icon={<Monitor size={18} />}
          detail={`${data.vms.filter((g) => g.status === 'stopped').length} arrêtée(s)`} color="var(--accent-2)" soft="rgba(34,211,238,.13)" onClick={() => navigate('guests')} />
        <Stat label="Conteneurs LXC" value={`${data.lxc.filter((g) => g.status === 'running').length} / ${data.lxc.length}`} icon={<Box size={18} />}
          detail={`${data.lxc.filter((g) => g.status === 'stopped').length} arrêté(s)`} color="var(--violet)" soft="rgba(167,139,250,.13)" onClick={() => navigate('guests')} />
        <Stat label="Mises à jour disponibles" value={data.scanned ? data.packages : '—'} icon={<Wrench size={18} />}
          detail={data.scanned ? `${data.security} de sécurité · ${data.reboots} redémarrage(s) requis` : 'Aucune analyse effectuée'}
          color="var(--warning)" soft="var(--warning-soft)" onClick={() => navigate('updates')} />
      </div>

      <div className="grid split" style={{ marginTop: 14 }}>
        <Card title="Utilisation des ressources" subtitle="Processeur et mémoire de l’ensemble des nœuds"
          actions={<span className="faint"><Dot c="var(--accent)" /> Processeur <Dot c="var(--accent-2)" /> Mémoire</span>}>
          {history.length > 1 ? (
            <TimeChart data={history} height={260} domain={[0, 100]} format={(v) => `${Math.round(v)} %`}
              series={[{ key: 'cpu', name: 'Processeur', color: '#3b82f6' }, { key: 'mem', name: 'Mémoire', color: '#22d3ee' }]} />
          ) : (
            <div style={{ height: 260, display: 'grid', placeItems: 'center' }} className="faint">Collecte des premières mesures…</div>
          )}
        </Card>
        <Card title="Capacité du cluster" subtitle="Utilisation instantanée">
          <Capacity label="Processeur" value={data.cpu} detail={`${pct(data.cpu)} de ${data.cpus} vCPU`} />
          <Capacity label="Mémoire" value={data.memTotal ? data.memUsed / data.memTotal : 0} detail={`${bytes(data.memUsed)} / ${bytes(data.memTotal)}`} />
          <Capacity label="Stockage" value={data.stTotal ? data.stUsed / data.stTotal : 0} detail={`${bytes(data.stUsed)} / ${bytes(data.stTotal)}`} warn={0.8} />
          <hr style={{ border: 0, borderTop: '1px solid var(--border-soft)', margin: '18px 0 14px' }} />
          <div className="faint" style={{ fontSize: 12 }}>Trafic réseau des invités</div>
          <div style={{ fontWeight: 600, marginTop: 3 }}>{lastNet ? `↓ ${rate(lastNet.netIn)}   ↑ ${rate(lastNet.netOut)}` : '—'}</div>
        </Card>
      </div>

      <div className="grid split" style={{ marginTop: 14 }}>
        <Card title="Nœuds" subtitle="État et charge de chaque hôte" actions={<button className="btn ghost sm" onClick={() => navigate('infrastructure')}>Tout voir</button>}>
          {data.nodes.map((n) => {
            const hosted = infra.snapshots.flatMap((s) => s.guests).filter((g) => g.serverId === n.serverId && g.node === n.name && !g.template)
            return (
              <div key={`${n.serverId}/${n.name}`} className="row" style={{ alignItems: 'center', padding: '11px 0', borderBottom: '1px solid var(--border-soft)' }}>
                <div className="icon-tile"><Server size={16} /></div>
                <div style={{ width: 180 }}>
                  <div style={{ fontWeight: 600 }}>{n.name}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{data.names.get(n.serverId)} · {hosted.filter((g) => g.status === 'running').length}/{hosted.length} invités · {uptime(n.uptime)}</div>
                </div>
                <div className="grow"><div className="metric-row"><span>CPU</span><b>{pct(n.cpu)}</b></div><Usage value={n.cpu} /></div>
                <div className="grow"><div className="metric-row"><span>RAM</span><b>{pct(n.memTotal ? n.memUsed / n.memTotal : 0)}</b></div><Usage value={n.memTotal ? n.memUsed / n.memTotal : 0} /></div>
                <div style={{ width: 100, textAlign: 'right' }}><StatusBadge status={n.status} /></div>
              </div>
            )
          })}
        </Card>
        <Card title="Alertes actives" subtitle="Conditions détectées en temps réel" actions={<button className="btn ghost sm" onClick={() => navigate('alerts')}>Tout voir</button>}>
          {alerts.active.length === 0 ? (
            <div className="empty" style={{ padding: 20 }}><CheckCircle2 size={22} color="var(--success)" /><span>Aucune alerte active</span></div>
          ) : (
            alerts.active.slice(0, 5).map((a) => (
              <div key={a.key} className="row" style={{ marginBottom: 12 }}>
                <AlertTriangle size={15} style={{ marginTop: 2, flex: 'none' }} color={a.severity === 'critical' ? 'var(--danger)' : a.severity === 'warning' ? 'var(--warning)' : 'var(--info)'} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>{a.title}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{a.message}</div>
                </div>
                <StatusBadge status={a.severity} />
              </div>
            ))
          )}
        </Card>
      </div>

      <div className="grid split" style={{ marginTop: 14 }}>
        <Card title="Invités les plus actifs" subtitle="Classés par charge processeur" className="flush">
          <table className="table">
            <thead><tr><th>Invité</th><th>Nœud</th><th style={{ width: '24%' }}>CPU</th><th>Mémoire</th><th>Actif depuis</th></tr></thead>
            <tbody>
              {data.top.map((g) => (
                <tr key={`${g.serverId}/${g.vmid}`}>
                  <td><span className="tag">{g.kind === 'lxc' ? 'LXC' : 'VM'}</span> <b style={{ marginLeft: 6 }}>{g.name}</b> <span className="faint">#{g.vmid}</span></td>
                  <td className="muted">{g.node}</td>
                  <td><div className="row" style={{ alignItems: 'center', gap: 8 }}><span style={{ width: 38 }}>{pct(g.cpu)}</span><div className="grow"><Usage value={g.cpu} /></div></div></td>
                  <td className="muted">{bytes(g.memUsed)} / {bytes(g.memTotal)}</td>
                  <td className="muted">{uptime(g.uptime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Activité récente" subtitle="Tâches Proxmox et maintenance BCenter">
          {activity.length === 0 && <div className="faint">Aucune activité récente.</div>}
          {activity.map((a, i) => (
            <div key={i} className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
              <div className="icon-tile" style={{ width: 30, height: 30, background: 'var(--panel-2)', color: 'var(--text-2)' }}>{a.icon}</div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.title}</div>
                <div className="faint" style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{relative(a.time)} · {a.detail}</div>
              </div>
              <Badge kind={a.kind}>{a.label}</Badge>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}

function Capacity({ label, value, detail, warn }: { label: string; value: number; detail: string; warn?: number }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div className="metric-row" style={{ fontSize: 13, color: 'var(--text)' }}><span>{label}</span><b>{pct(value)}</b></div>
      <Usage value={value} warn={warn} />
      <div className="faint" style={{ fontSize: 12, marginTop: 5 }}>{detail}</div>
    </div>
  )
}

function Dot({ c }: { c: string }) {
  return <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: c, margin: '0 5px 0 12px' }} />
}
