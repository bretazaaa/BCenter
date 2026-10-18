import { Network, Server } from 'lucide-react'
import { Badge, Card, Empty, StatusBadge, Usage } from '../components/ui'
import { bytes, pct, uptime } from '../lib/format'
import { useApp } from '../store'

export function InfrastructurePage() {
  const { infra, navigate } = useApp()

  if (infra.servers.length === 0) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty icon={<Network size={24} />} title="Aucun serveur" message="Ajoutez un serveur Proxmox VE pour afficher vos nœuds et stockages.">
          <button className="btn primary" onClick={() => navigate('settings')}>Ajouter un serveur</button>
        </Empty>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head"><div><h1>Infrastructure</h1><p>Serveurs, nœuds et stockages</p></div></div>
      {infra.servers.map((server) => {
        const snap = infra.snapshots.find((s) => s.server.id === server.id)
        const guests = snap?.guests.filter((g) => !g.template) ?? []
        const version = snap?.nodes.find((n) => n.version)?.version
        return (
          <section key={server.id} style={{ marginBottom: 28 }}>
            <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
              <div className="icon-tile" style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#3b82f6,#22d3ee)', color: 'white' }}><Network size={20} /></div>
              <div className="grow">
                <div style={{ fontSize: 16, fontWeight: 600 }}>{server.name} <span className="mono faint" style={{ marginLeft: 8 }}>{server.host}:{server.port}</span></div>
                <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                  {snap?.reachable
                    ? `${snap.nodes.length} nœud(s) · ${guests.filter((g) => g.kind === 'qemu').length} VM · ${guests.filter((g) => g.kind === 'lxc').length} LXC · ${snap.storages.length} stockage(s)`
                    : snap ? 'Injoignable' : 'En attente de la première actualisation…'}
                  {'  ·  '}
                  {server.pinnedFingerprint ? 'Certificat épinglé (empreinte approuvée)' : 'Certificat validé par Windows'}
                </div>
              </div>
              {version && <span className="faint" style={{ fontSize: 12 }}>{version}</span>}
              {snap && <Badge kind={snap.reachable ? 'success' : 'danger'}>{snap.reachable ? 'Connecté' : 'Injoignable'}</Badge>}
            </div>
            {snap?.error && <div className="callout danger" style={{ marginBottom: 14 }}>{snap.error}</div>}

            <div className="grid three">
              {snap?.nodes.map((n) => {
                const hosted = guests.filter((g) => g.node === n.name)
                const mem = n.memTotal ? n.memUsed / n.memTotal : 0
                const disk = n.diskTotal ? n.diskUsed / n.diskTotal : 0
                return (
                  <div className="card" key={n.name}>
                    <div className="row" style={{ alignItems: 'center' }}>
                      <Server size={16} color="var(--accent)" />
                      <b className="grow" style={{ fontSize: 14 }}>{n.name}</b>
                      <StatusBadge status={n.status} />
                    </div>
                    <div className="faint" style={{ fontSize: 12, margin: '4px 0 16px 26px' }}>
                      {hosted.filter((g) => g.status === 'running').length} / {hosted.length} invités actifs · en ligne depuis {uptime(n.uptime)}
                    </div>
                    <div className="metric-row"><span>Processeur</span><b>{pct(n.cpu)} · {n.cpuCount} vCPU</b></div>
                    <Usage value={n.cpu} />
                    <div className="metric-row" style={{ marginTop: 12 }}><span>Mémoire</span><b>{bytes(n.memUsed)} / {bytes(n.memTotal)}</b></div>
                    <Usage value={mem} />
                    <div className="metric-row" style={{ marginTop: 12 }}><span>Disque système</span><b>{bytes(n.diskUsed)} / {bytes(n.diskTotal)}</b></div>
                    <Usage value={disk} warn={0.8} />
                    {n.version && <div className="faint" style={{ fontSize: 11, marginTop: 14 }}>{n.version}</div>}
                  </div>
                )
              })}
            </div>

            {snap && snap.storages.length > 0 && (
              <Card title="Stockages" subtitle="Espaces de stockage déclarés sur le serveur" className="flush" >
                <table className="table">
                  <thead><tr><th>Nom</th><th>Nœud</th><th>Type</th><th>Contenu</th><th style={{ width: '30%' }}>Utilisation</th><th>Partagé</th></tr></thead>
                  <tbody>
                    {snap.storages.map((s) => (
                      <tr key={`${s.node}/${s.name}`}>
                        <td><b>{s.name}</b></td>
                        <td className="muted">{s.node}</td>
                        <td className="muted">{s.type}</td>
                        <td className="muted">{s.content.join(', ')}</td>
                        <td>
                          <div className="row" style={{ alignItems: 'center' }}>
                            <div className="grow"><Usage value={s.total ? s.used / s.total : 0} warn={0.8} /></div>
                            <span className="muted" style={{ fontSize: 12, width: 130, textAlign: 'right' }}>{bytes(s.used)} / {bytes(s.total)}</span>
                          </div>
                        </td>
                        <td>{s.shared ? <Badge kind="info" plain>Oui</Badge> : <span className="faint">Non</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        )
      })}
    </div>
  )
}
