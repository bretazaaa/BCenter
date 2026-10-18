import { Download, KeyRound, Plus, RefreshCw, RotateCcw, Search, ShieldAlert, TerminalSquare, Trash2, Undo2, Wrench, X, Server, Copy } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { GuestInfo, HostKeyInfo, SnapshotInfo, SshTarget } from '@shared/types'
import { confirm, useAction } from '../components/dialogs'
import { Badge, Callout, Check, Empty, Field, JobBadge, Modal, Stat } from '../components/ui'
import { api } from '../lib/api'
import { clock, dateTime, relative } from '../lib/format'
import { attempt, useApp } from '../store'

export function UpdatesPage() {
  const { targets, scans, jobs, jobLogs, selectedJobId, selectJob, settings, openShell } = useApp()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [snapshots, setSnapshots] = useState<Record<string, SnapshotInfo | null>>({})
  const [adding, setAdding] = useState(false)
  const [upgrading, setUpgrading] = useState<SshTarget[] | null>(null)

  const loadSnapshots = async () => {
    const result: Record<string, SnapshotInfo | null> = {}
    await Promise.all(targets.filter((t) => t.vmid != null).map(async (t) => {
      result[t.id] = await api.targetSnapshots(t.id).then((s) => s[0] ?? null).catch(() => null)
    }))
    setSnapshots(result)
  }

  const finishedCount = jobs.filter((j) => j.finishedAt).length
  useEffect(() => {
    void loadSnapshots()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, finishedCount])

  const chosen = targets.filter((t) => selected.has(t.id))
  const busy = new Set(jobs.filter((j) => j.status === 'running' || j.status === 'queued').map((j) => j.targetId))
  const scanned = targets.map((t) => scans[t.id]).filter((s) => s?.system)
  const packages = scanned.reduce((n, s) => n + s!.packages.length, 0)
  const security = scanned.reduce((n, s) => n + s!.packages.filter((p) => p.security).length, 0)
  const reboots = targets.filter((t) => scans[t.id]?.rebootRequired).length
  const selectedJob = jobs.find((j) => j.id === selectedJobId)

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const rollback = async () => {
    const target = chosen[0]
    const snap = target && snapshots[target.id]
    if (!target || !snap) {
      useApp.getState().toast('info', target?.vmid == null ? 'Cette machine n’est liée à aucun invité Proxmox.' : 'Aucun snapshot BCenter à restaurer.')
      return
    }
    const ok = await confirm({
      title: 'Restaurer le snapshot',
      danger: true,
      confirmText: 'Restaurer',
      message: `Restaurer ${target.name} dans l’état du ${dateTime(snap.createdAt)} ? Toutes les modifications faites depuis (fichiers, bases de données, paquets) seront définitivement perdues. L’invité sera redémarré.`,
      details: `${snap.name}\n${snap.description ?? ''}`,
    })
    if (ok) await attempt(() => api.rollback(target.id, snap.name))
  }

  const reboot = async () => {
    const ok = await confirm({
      title: 'Redémarrer', danger: true, confirmText: 'Redémarrer',
      message: `Redémarrer ${chosen.length} machine(s) maintenant ? Les services hébergés seront interrompus.`,
      details: chosen.map((t) => t.name).join(', '),
    })
    if (ok) await attempt(() => api.reboot(chosen.map((t) => t.id)))
  }

  const remove = async () => {
    const ok = await confirm({
      title: 'Retirer des machines', danger: true, confirmText: 'Retirer',
      message: `Retirer ${chosen.length} machine(s) du centre de mises à jour ? Aucune modification n’est faite sur les machines.`,
    })
    if (!ok) return
    for (const t of chosen) await attempt(() => api.removeTarget(t.id))
    setSelected(new Set())
    await useApp.getState().reloadLists()
  }

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="page-head">
        <div><h1>Centre de mises à jour</h1><p>Maintenance des machines via SSH, avec snapshot Proxmox préalable</p></div>
        <div className="actions">
          <button className="btn primary" onClick={() => setAdding(true)}><Plus size={14} /> Ajouter une machine</button>
          <button className="btn" disabled={!targets.length} onClick={() => void attempt(() => api.scan(targets.map((t) => t.id)))}><RefreshCw size={14} /> Tout analyser</button>
        </div>
      </div>

      <div className="grid kpi" style={{ marginBottom: 14 }}>
        <Stat label="Machines suivies" value={targets.length} detail={`${scanned.length} / ${targets.length} analysée(s)`} icon={<Server size={18} />} />
        <Stat label="Paquets à mettre à jour" value={packages} detail="Toutes machines confondues" icon={<Download size={18} />} color="var(--accent-2)" soft="rgba(34,211,238,.13)" />
        <Stat label="Correctifs de sécurité" value={security} detail="À appliquer en priorité" icon={<ShieldAlert size={18} />} color="var(--danger)" soft="var(--danger-soft)" />
        <Stat label="Redémarrages requis" value={reboots} detail="Après mise à jour du noyau ou des bibliothèques" icon={<RotateCcw size={18} />} color="var(--warning)" soft="var(--warning-soft)" />
      </div>

      <div className="row" style={{ marginBottom: 12, alignItems: 'center' }}>
        <span className="faint">{chosen.length ? `${chosen.length} machine(s) sélectionnée(s)` : 'Sélectionnez une ou plusieurs machines'}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={chosen.length !== 1} onClick={() => openShell(chosen[0])}><TerminalSquare size={14} /> Shell</button>
        <button className="btn" disabled={!chosen.length} onClick={() => void attempt(() => api.scan(chosen.map((t) => t.id)))}><Search size={14} /> Analyser</button>
        <button className="btn primary" disabled={!chosen.length} onClick={() => setUpgrading(chosen)}><Download size={14} /> Mettre à jour</button>
        <button className="btn" disabled={chosen.length !== 1} onClick={() => void rollback()}><Undo2 size={14} /> Restaurer le snapshot</button>
        <button className="btn" disabled={!chosen.length} onClick={() => void reboot()}><RotateCcw size={14} /> Redémarrer</button>
        <button className="btn ghost" disabled={!chosen.length} onClick={() => void remove()}><Trash2 size={14} /> Retirer</button>
      </div>

      <div className="grid split" style={{ flex: 1, minHeight: 260 }}>
        <div className="card flush table-wrap">
          {targets.length === 0 ? (
            <Empty icon={<Wrench size={24} />} title="Aucune machine suivie" message="Ajoutez des VM ou conteneurs accessibles en SSH pour analyser et appliquer leurs mises à jour depuis BCenter.">
              <button className="btn primary" onClick={() => setAdding(true)}><Plus size={14} /> Ajouter une machine</button>
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="w-check"><Check checked={targets.length > 0 && selected.size === targets.length} onChange={(v) => setSelected(v ? new Set(targets.map((t) => t.id)) : new Set())} /></th>
                  <th>Machine</th><th>Système</th><th>Mises à jour</th><th>Redémarrage</th><th>Snapshot</th><th>Analyse</th><th />
                </tr>
              </thead>
              <tbody>
                {targets.map((t) => {
                  const scan = scans[t.id]
                  const snap = snapshots[t.id]
                  const sec = scan?.packages.filter((p) => p.security).length ?? 0
                  return (
                    <tr key={t.id} className={`clickable${selected.has(t.id) ? ' selected' : ''}`} onClick={() => toggle(t.id)}>
                      <td onClick={(e) => e.stopPropagation()}><Check checked={selected.has(t.id)} onChange={() => toggle(t.id)} /></td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{t.name} {busy.has(t.id) && <RefreshCw size={12} className="spin" style={{ color: 'var(--accent)', marginLeft: 4 }} />}</div>
                        <div className="faint" style={{ fontSize: 11.5 }}>{t.host}:{t.port}</div>
                      </td>
                      <td className="muted">{scan?.system ? `${scan.system.osName ?? ''} ${scan.system.osVersion ?? ''}` : '—'}</td>
                      <td>
                        {!scan?.system ? <span className="faint">—</span> : scan.packages.length === 0 ? <Badge kind="success">À jour</Badge> : (
                          <span className="row" style={{ gap: 6 }}>
                            <Badge kind="accent">{scan.packages.length} paquet(s)</Badge>
                            {sec > 0 && <Badge kind="danger">{sec} sécu.</Badge>}
                          </span>
                        )}
                      </td>
                      <td>{scan?.rebootRequired ? <Badge kind="warning">Requis</Badge> : <span className="faint">—</span>}</td>
                      <td>
                        {t.vmid == null ? <span className="faint">Non lié</span> : (
                          <>
                            <div style={{ color: snap ? 'var(--success)' : 'var(--text-3)', fontSize: 12 }}>{snap ? relative(snap.createdAt) : 'Aucun'}</div>
                            <div className="faint" style={{ fontSize: 11 }}>#{t.vmid} · {t.node}</div>
                          </>
                        )}
                      </td>
                      <td className="muted">{scan ? relative(scan.scannedAt) : 'Jamais'}</td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button className="btn ghost sm icon" title="Ouvrir un shell" onClick={() => openShell(t)}><TerminalSquare size={14} /></button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="card-head"><div><h3>Tâches</h3><p>Exécutées tant que BCenter est ouvert</p></div></div>
          <div style={{ overflow: 'auto', flex: 1, margin: '0 -6px' }}>
            {jobs.length === 0 && <div className="faint" style={{ padding: '0 6px' }}>Aucune tâche pour le moment.</div>}
            {jobs.map((j) => (
              <div key={j.id} className={`list-item${j.id === selectedJobId ? ' selected' : ''}`} onClick={() => void selectJob(j.id)}>
                <div className="main">
                  <div>{j.title}</div>
                  <div>{clock(j.startedAt ?? j.queuedAt)} · {j.stage ?? j.summary ?? 'En attente'}</div>
                </div>
                <JobBadge status={j.status} />
                {(j.status === 'running' || j.status === 'queued') && (
                  <button className="btn ghost sm icon" title="Annuler la tâche" onClick={(e) => { e.stopPropagation(); void api.cancelJob(j.id) }}><X size={13} /></button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <JobLogPanel jobId={selectedJobId} title={selectedJob?.title} lines={selectedJobId ? jobLogs[selectedJobId] ?? [] : []} />

      {adding && <AddTargetModal onClose={() => setAdding(false)} />}
      {upgrading && <UpgradeModal targets={upgrading} snapshotDefault={settings?.snapshotBeforeUpdate ?? true} retention={settings?.snapshotRetentionDays ?? 7} onClose={() => setUpgrading(null)} />}
    </div>
  )
}

function JobLogPanel({ jobId, title, lines }: { jobId: string | null; title?: string; lines: { time: number; level: string; text: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight })
  }, [lines.length, jobId])
  return (
    <div className="card" style={{ marginTop: 14, height: 250, display: 'flex', flexDirection: 'column', flex: 'none' }}>
      <div className="card-head">
        <div><h3>Journal d’exécution</h3><p>{title ?? 'Sélectionnez une tâche'}</p></div>
        <div className="actions">
          <button className="btn ghost sm" disabled={!lines.length} onClick={() => void navigator.clipboard.writeText(lines.map((l) => `${clock(l.time)} [${l.level}] ${l.text}`).join('\n'))}>
            <Copy size={13} /> Copier
          </button>
        </div>
      </div>
      <div ref={ref} className="mono selectable" style={{ flex: 1, overflow: 'auto', background: 'var(--input)', borderRadius: 9, border: '1px solid var(--border-soft)', padding: '8px 12px', lineHeight: 1.6 }}>
        {lines.map((l, i) => (
          <div className="logline" key={i}><span className="t">{clock(l.time)}</span><span className={`lv-${l.level}`}>{l.text}</span></div>
        ))}
      </div>
    </div>
  )
}

/** Ajout d'une machine : invité Proxmox (facultatif), adresse, identifiants et vérification de la clé d'hôte. */
export function AddTargetModal({ guest: preselected, onClose }: { guest?: GuestInfo; onClose: () => void }) {
  const { infra, credentials } = useApp()
  const guests = useMemo(() => infra.snapshots.flatMap((s) => s.guests).filter((g) => !g.template).sort((a, b) => a.vmid - b.vmid), [infra])
  const names = new Map(infra.servers.map((s) => [s.id, s.name]))
  const [guest, setGuest] = useState<GuestInfo | null>(preselected ?? null)
  const [name, setName] = useState(preselected?.name ?? '')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [credentialId, setCredentialId] = useState(credentials[0]?.id ?? '')
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null)
  const [trusted, setTrusted] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const { busy, error, setError, run } = useAction()

  const discover = async (g: GuestInfo) => {
    setStatus('Recherche des adresses IP de l’invité…')
    try {
      const addresses = await api.guestAddresses(g)
      if (addresses[0]) {
        setHost(addresses[0])
        setStatus('Adresse détectée. Lisez ensuite la clé d’hôte.')
      } else {
        setStatus(g.kind === 'qemu' ? 'Aucune adresse détectée (agent QEMU absent ?). Saisissez l’adresse manuellement.' : 'Aucune adresse détectée. Saisissez l’adresse manuellement.')
      }
    } catch (e) {
      setStatus(`Détection impossible : ${(e as Error).message}`)
    }
  }

  useEffect(() => {
    if (preselected) void discover(preselected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseGuest = (key: string) => {
    const g = guests.find((x) => `${x.serverId}/${x.vmid}` === key) ?? null
    setGuest(g)
    if (g) {
      setName(g.name)
      void discover(g)
    }
  }

  const resetKey = () => { setHostKey(null); setTrusted(false) }
  const probe = () => run(async () => {
    setStatus('Lecture de la clé d’hôte SSH…')
    const key = await api.probeHostKey(host.trim(), Number(port))
    setHostKey(key)
    setTrusted(false)
    setStatus('Comparez l’empreinte avec celle de la machine (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) avant de l’approuver.')
  })

  const save = () => run(async () => {
    setStatus('Test de la connexion SSH…')
    await api.addTarget({ name, host: host.trim(), port: Number(port), credentialId, hostKey: hostKey!, guest })
    await useApp.getState().reloadLists()
    useApp.getState().toast('success', `${name} ajoutée au centre de mises à jour. Analyse en cours…`)
    onClose()
  })

  const canSave = !!name.trim() && !!host.trim() && !!credentialId && !!hostKey && trusted && !busy

  return (
    <Modal
      title="Ajouter une machine"
      width={640}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error}</span>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={!canSave} onClick={() => void save()}>{busy ? 'Vérification…' : 'Ajouter'}</button>
        </>
      }
    >
      {credentials.length === 0 && <div style={{ marginBottom: 14 }}><Callout kind="warning">Aucun identifiant SSH : ajoutez-en d’abord depuis Réglages › Identifiants SSH.</Callout></div>}
      <Field label="Invité Proxmox (facultatif)" hint="Lier la machine à un invité permet le snapshot préalable, la restauration et la détection automatique de l’adresse IP.">
        <select className="select" value={guest ? `${guest.serverId}/${guest.vmid}` : ''} onChange={(e) => chooseGuest(e.target.value)}>
          <option value="">— Machine non gérée par Proxmox —</option>
          {guests.map((g) => (
            <option key={`${g.serverId}/${g.vmid}`} value={`${g.serverId}/${g.vmid}`}>{g.vmid} · {g.name} ({g.kind === 'lxc' ? 'LXC' : 'VM'}, {names.get(g.serverId)} / {g.node})</option>
          ))}
        </select>
      </Field>
      <Field label="Nom"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="srv-web-01" /></Field>
      <div className="row">
        <div className="grow"><Field label="Adresse SSH"><input className="input" value={host} onChange={(e) => { setHost(e.target.value); resetKey() }} placeholder="192.168.1.20" /></Field></div>
        <div style={{ width: 90 }}><Field label="Port"><input className="input" value={port} onChange={(e) => { setPort(e.target.value); resetKey() }} /></Field></div>
      </div>
      <Field label="Identifiants SSH">
        <select className="select" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          {credentials.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.username})</option>)}
        </select>
      </Field>

      <div className="card" style={{ background: 'var(--panel-2)' }}>
        <div className="card-head">
          <div><h3>Clé d’hôte SSH</h3><p>Obligatoire : protège contre l’usurpation de la machine</p></div>
          <div className="actions"><button className="btn sm" disabled={!host.trim() || busy} onClick={() => { setError(null); void probe() }}><KeyRound size={13} /> Lire la clé</button></div>
        </div>
        <div className="mono selectable" style={{ overflowWrap: 'anywhere' }}>{hostKey ? `${hostKey.algorithm} SHA256:${hostKey.fingerprint}` : <span className="faint">Aucune clé lue.</span>}</div>
        {hostKey && <div style={{ marginTop: 12 }}><Check checked={trusted} onChange={setTrusted}>J’ai vérifié que cette empreinte correspond à la machine et je l’approuve.</Check></div>}
      </div>
      {status && <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>{status}</div>}
    </Modal>
  )
}

function UpgradeModal({ targets, snapshotDefault, retention, onClose }: { targets: SshTarget[]; snapshotDefault: boolean; retention: number; onClose: () => void }) {
  const linked = targets.filter((t) => t.vmid != null).length
  const unlinked = targets.length - linked
  const [snapshot, setSnapshot] = useState(snapshotDefault && linked > 0)
  const [full, setFull] = useState(false)
  const [reboot, setReboot] = useState(false)
  const [ack, setAck] = useState(false)
  const canAccept = ack || (snapshot && unlinked === 0)

  const start = async () => {
    await attempt(() => api.upgrade(targets.map((t) => t.id), { snapshotFirst: snapshot, fullUpgrade: full, rebootIfRequired: reboot }))
    onClose()
  }

  return (
    <Modal
      title="Mettre à jour"
      width={580}
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={!canAccept} onClick={() => void start()}><Download size={14} /> Lancer la mise à jour</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>Les paquets des machines suivantes vont être mis à jour depuis BCenter via SSH :</p>
      <div className="mono" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--input)', marginBottom: 18 }}>{targets.map((t) => t.name).join(', ')}</div>
      <div className="stack" style={{ gap: 14 }}>
        <Check checked={snapshot} disabled={linked === 0} onChange={setSnapshot}>
          <b>Prendre un snapshot Proxmox avant la mise à jour</b>
          <div className="faint" style={{ fontSize: 12 }}>
            {unlinked === 0
              ? `Snapshot instantané de chaque invité, restaurable en un clic et supprimé automatiquement après ${retention} jour(s). Si le snapshot échoue, la mise à jour est annulée.`
              : `${unlinked} machine(s) ne sont liées à aucun invité Proxmox et seront mises à jour sans snapshot.`}
          </div>
        </Check>
        <Check checked={full} onChange={setFull}>
          <b>Mise à niveau complète (full-upgrade / dist-upgrade)</b>
          <div className="faint" style={{ fontSize: 12 }}>Autorise l’installation ou la suppression de paquets pour résoudre les dépendances.</div>
        </Check>
        <Check checked={reboot} onChange={setReboot}>
          <b>Redémarrer automatiquement si nécessaire</b>
          <div className="faint" style={{ fontSize: 12 }}>Les services hébergés seront interrompus pendant le redémarrage.</div>
        </Check>
        <div className="callout warning">
          <Check checked={ack} onChange={setAck}>
            Je confirme le lancement de cette opération. Les tâches continuent si BCenter est réduit, mais seront interrompues si BCenter est quitté ou si le PC est éteint.
          </Check>
        </div>
      </div>
    </Modal>
  )
}
