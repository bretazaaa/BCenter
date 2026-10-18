import { Monitor, Play, Power, RotateCcw, Search, Square, TerminalSquare, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { GuestInfo, PowerAction } from '@shared/types'
import { confirm } from '../components/dialogs'
import { Check, Empty, Segmented, StatusBadge, Usage } from '../components/ui'
import { api } from '../lib/api'
import { bytes, pct, uptime } from '../lib/format'
import { attempt, useApp } from '../store'
import { AddTargetModal } from './Updates'

type Kind = 'all' | 'qemu' | 'lxc'
type State = 'all' | 'running' | 'stopped'
const keyOf = (g: GuestInfo) => `${g.serverId}/${g.vmid}`

export function GuestsPage() {
  const { infra, search, setSearch, targets, openShell } = useApp()
  const [kind, setKind] = useState<Kind>('all')
  const [state, setState] = useState<State>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [maintenanceGuest, setMaintenanceGuest] = useState<GuestInfo | null>(null)
  const names = new Map(infra.servers.map((s) => [s.id, s.name]))

  const all = useMemo(() => infra.snapshots.flatMap((s) => s.guests).filter((g) => !g.template).sort((a, b) => a.vmid - b.vmid), [infra])
  const visible = all.filter((g) => {
    if (kind !== 'all' && g.kind !== kind) return false
    if (state === 'running' && g.status !== 'running') return false
    if (state === 'stopped' && g.status === 'running') return false
    const q = search.trim().toLowerCase()
    return !q || g.name.toLowerCase().includes(q) || String(g.vmid).includes(q) || g.node.toLowerCase().includes(q) || g.tags.some((t) => t.toLowerCase().includes(q))
  })
  const chosen = all.filter((g) => selected.has(keyOf(g)))
  // Machine du centre de mises à jour correspondant à l'invité : liée explicitement, sinon même nom.
  const linkedTarget = chosen.length === 1
    ? targets.find((t) => t.serverId === chosen[0].serverId && t.vmid === chosen[0].vmid)
      ?? targets.find((t) => t.vmid == null && t.name.toLowerCase() === chosen[0].name.toLowerCase())
    : undefined

  const shell = () => {
    if (linkedTarget) return openShell(linkedTarget)
    useApp.getState().toast('info', 'Configurez d’abord l’accès SSH de cet invité : il sera ensuite disponible dans le centre de mises à jour.')
    setMaintenanceGuest(chosen[0])
  }

  const toggle = (g: GuestInfo) =>
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(keyOf(g))) next.delete(keyOf(g))
      else next.add(keyOf(g))
      return next
    })

  const power = async (action: PowerAction) => {
    if (chosen.length === 0) return
    const verb = { start: 'Démarrer', shutdown: 'Arrêter', reboot: 'Redémarrer', stop: 'Forcer l’arrêt de' }[action]
    if (action !== 'start') {
      const ok = await confirm({
        title: verb,
        danger: true,
        confirmText: verb,
        message: action === 'stop'
          ? `${verb} ${chosen.length} invité(s) ? L’arrêt forcé équivaut à couper l’alimentation et peut entraîner une perte de données.`
          : `${verb} ${chosen.length} invité(s) ?`,
        details: chosen.map((g) => `${g.vmid} · ${g.name}`).join('\n'),
      })
      if (!ok) return
    }
    for (const g of chosen) await attempt(() => api.powerAction(g, action))
    useApp.getState().toast('info', `Action envoyée à ${chosen.length} invité(s).`)
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div><h1>VM / LXC</h1><p>Machines virtuelles et conteneurs</p></div>
        <div className="actions">
          <button className="btn" disabled={!chosen.length} onClick={() => void power('start')}><Play size={14} /> Démarrer</button>
          <button className="btn" disabled={!chosen.length} onClick={() => void power('shutdown')}><Power size={14} /> Arrêter</button>
          <button className="btn" disabled={!chosen.length} onClick={() => void power('reboot')}><RotateCcw size={14} /> Redémarrer</button>
          <button className="btn" disabled={!chosen.length} onClick={() => void power('stop')}><Square size={14} /> Forcer l’arrêt</button>
          <button className="btn" disabled={chosen.length !== 1} onClick={shell}
            title={chosen.length === 1 && !linkedTarget ? 'Accès SSH à configurer pour cet invité' : 'Ouvrir un shell SSH'}>
            <TerminalSquare size={14} /> Shell
          </button>
          <button className="btn primary" disabled={chosen.length !== 1 || !!linkedTarget} onClick={() => setMaintenanceGuest(chosen[0])}><Wrench size={14} /> Maintenance</button>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <label className="search" style={{ width: 320 }}>
          <Search size={14} />
          <input placeholder="Filtrer par nom, ID, nœud ou tag" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <Segmented value={kind} onChange={setKind} options={[['all', 'Tous'], ['qemu', 'VM'], ['lxc', 'LXC']]} />
        <Segmented value={state} onChange={setState} options={[['all', 'Tous états'], ['running', 'En marche'], ['stopped', 'Arrêtés']]} />
        <span className="faint">{visible.length === all.length ? `${all.length} invité(s)` : `${visible.length} sur ${all.length} invité(s)`}{chosen.length ? ` · ${chosen.length} sélectionné(s)` : ''}</span>
      </div>

      <div className="card flush table-wrap" style={{ flex: 1, minHeight: 0 }}>
        {all.length === 0 ? (
          <Empty icon={<Monitor size={24} />} title="Aucun invité" message="Aucune machine virtuelle ni conteneur à afficher." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th className="w-check"><Check checked={visible.length > 0 && visible.every((g) => selected.has(keyOf(g)))} onChange={(v) => setSelected(v ? new Set(visible.map(keyOf)) : new Set())} /></th>
                <th>État</th><th>ID</th><th>Nom</th><th>Nœud</th><th style={{ width: '14%' }}>CPU</th><th style={{ width: '16%' }}>Mémoire</th><th>Disque</th><th>Actif depuis</th><th>Tags</th><th>Serveur</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((g) => (
                <tr key={keyOf(g)} className={`clickable${selected.has(keyOf(g)) ? ' selected' : ''}`} onClick={() => toggle(g)}>
                  <td onClick={(e) => e.stopPropagation()}><Check checked={selected.has(keyOf(g))} onChange={() => toggle(g)} /></td>
                  <td><StatusBadge status={g.status} /></td>
                  <td className="muted">{g.vmid}</td>
                  <td><span className="tag">{g.kind === 'lxc' ? 'LXC' : 'VM'}</span> <b style={{ marginLeft: 6 }}>{g.name}</b></td>
                  <td className="muted">{g.node}</td>
                  <td>{g.status === 'running' ? <div className="row" style={{ alignItems: 'center', gap: 8 }}><span style={{ width: 38 }}>{pct(g.cpu)}</span><div className="grow"><Usage value={g.cpu} /></div></div> : <span className="faint">—</span>}</td>
                  <td>
                    <div className="muted" style={{ fontSize: 12 }}>{g.status === 'running' ? `${bytes(g.memUsed)} / ${bytes(g.memTotal)}` : bytes(g.memTotal)}</div>
                    {g.status === 'running' && <div style={{ marginTop: 4 }}><Usage value={g.memTotal ? g.memUsed / g.memTotal : 0} /></div>}
                  </td>
                  <td className="muted">{bytes(g.diskTotal)}</td>
                  <td className="muted">{g.status === 'running' ? uptime(g.uptime) : '—'}</td>
                  <td className="muted">{g.tags.join(', ')}</td>
                  <td className="muted">{names.get(g.serverId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {maintenanceGuest && <AddTargetModal guest={maintenanceGuest} onClose={() => setMaintenanceGuest(null)} />}
    </div>
  )
}
