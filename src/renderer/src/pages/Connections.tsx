import { Box, Folder, FolderOpen, HardDrive, Monitor, Pencil, Plus, Search, Server, Sparkles, TerminalSquare, Trash2, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { GuestInfo, NasProfile, SshTarget } from '@shared/types'
import { confirm, useAction } from '../components/dialogs'
import { Badge, Card, Empty, Field, Modal } from '../components/ui'
import { api } from '../lib/api'
import { relative } from '../lib/format'
import { attempt, useApp } from '../store'
import { AddTargetModal } from './Updates'

type Filter = { kind: 'all' } | { kind: 'group'; group: string | null } | { kind: 'suggestions' }
type AddRequest = { guest?: GuestInfo; nas?: NasProfile; group?: string | null }

const ALL: Filter = { kind: 'all' }

/** Type d'une connexion, déduit de ses liens avec Proxmox et les NAS. */
function typeOf(t: SshTarget, nas: NasProfile[]): { label: string; icon: React.ReactNode } {
  if (nas.some((n) => n.sshTargetId === t.id)) return { label: 'NAS', icon: <HardDrive size={15} /> }
  if (t.guestKind === 'lxc') return { label: 'LXC', icon: <Box size={15} /> }
  if (t.guestKind === 'qemu') return { label: 'VM', icon: <Monitor size={15} /> }
  return { label: 'Serveur', icon: <Server size={15} /> }
}

/**
 * Inventaire central des machines accessibles en SSH : rangement par dossiers et tags, shell en un clic,
 * et suggestions pour les invités Proxmox et NAS pas encore configurés.
 */
export function ConnectionsPage() {
  const { targets, credentials, infra, nas, scans, openShell, navigate, reloadLists } = useApp()
  const [filter, setFilter] = useState<Filter>(ALL)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<SshTarget | null>(null)
  const [adding, setAdding] = useState<AddRequest | null>(null)

  const users = new Map(credentials.map((c) => [c.id, c.username]))
  const groups = useMemo(() => [...new Set(targets.map((t) => t.group).filter((g): g is string => !!g))].sort((a, b) => a.localeCompare(b)), [targets])

  // Invités Proxmox et NAS sans connexion SSH : proposés à la configuration.
  const suggestions = useMemo(() => {
    const guests = infra.snapshots.flatMap((s) => s.guests).filter((g) => !g.template)
      .filter((g) => !targets.some((t) => (t.serverId === g.serverId && t.vmid === g.vmid) || (t.vmid == null && t.name.toLowerCase() === g.name.toLowerCase())))
      .sort((a, b) => a.vmid - b.vmid)
    const freeNas = nas.systems.filter((n) => !n.sshTargetId || !targets.some((t) => t.id === n.sshTargetId))
    return { guests, nas: freeNas }
  }, [infra, nas, targets])
  const suggestionCount = suggestions.guests.length + suggestions.nas.length

  const q = search.trim().toLowerCase()
  const shown = targets.filter((t) => {
    if (filter.kind === 'group' && t.group !== filter.group) return false
    return !q || [t.name, t.host, t.group ?? '', ...t.tags].some((v) => v.toLowerCase().includes(q))
  })

  const remove = async (t: SshTarget) => {
    if (await confirm({ title: 'Supprimer la connexion', danger: true, confirmText: 'Supprimer', message: `Retirer ${t.name} de BCenter ? Les identifiants SSH partagés sont conservés. Rien n’est modifié sur la machine.` })) {
      await attempt(() => api.removeTarget(t.id), 'Connexion supprimée.')
      await reloadLists()
    }
  }

  const addNasLinked = async (target: SshTarget) => {
    if (!adding?.nas) return
    await api.linkNasTarget(adding.nas.id, target.id)
    useApp.setState({ nas: await api.getNas() })
  }

  return (
    <div className="page">
      <div className="page-head">
        <div><h1>Connexions</h1><p>Toutes vos machines au même endroit : shell, rangement et accès rapide</p></div>
        <div className="actions">
          <label className="search" style={{ width: 280 }}>
            <Search size={14} />
            <input placeholder="Nom, adresse, dossier ou tag…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <button className="btn primary" onClick={() => setAdding({ group: filter.kind === 'group' ? filter.group : null })}><Plus size={14} /> Nouvelle connexion</button>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div className="card" style={{ width: 230, flex: 'none', padding: 8 }}>
          <FolderButton active={filter.kind === 'all'} icon={<FolderOpen size={15} />} label="Toutes" count={targets.length} onClick={() => setFilter(ALL)} />
          {groups.map((g) => (
            <FolderButton key={g} active={filter.kind === 'group' && filter.group === g} icon={<Folder size={15} />} label={g}
              count={targets.filter((t) => t.group === g).length} onClick={() => setFilter({ kind: 'group', group: g })} />
          ))}
          {targets.some((t) => !t.group) && groups.length > 0 && (
            <FolderButton active={filter.kind === 'group' && filter.group === null} icon={<Folder size={15} />} label="Sans dossier"
              count={targets.filter((t) => !t.group).length} onClick={() => setFilter({ kind: 'group', group: null })} />
          )}
          <hr style={{ border: 0, borderTop: '1px solid var(--border-soft)', margin: '8px 4px' }} />
          <FolderButton active={filter.kind === 'suggestions'} icon={<Sparkles size={15} />} label="À configurer" count={suggestionCount} onClick={() => setFilter({ kind: 'suggestions' })} />
        </div>

        <div className="grow">
          {filter.kind === 'suggestions' ? (
            <Card title="À configurer" subtitle="Invités Proxmox et NAS sans accès SSH : configurez-les pour ouvrir un shell et suivre leurs mises à jour" className="flush">
              {suggestionCount === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Tout est configuré.</div> : (
                <table className="table">
                  <thead><tr><th>Nom</th><th>Type</th><th>Emplacement</th><th>État</th><th /></tr></thead>
                  <tbody>
                    {suggestions.nas.map((n) => (
                      <tr key={n.id}>
                        <td><b>{n.name}</b></td>
                        <td className="muted"><HardDrive size={13} style={{ verticalAlign: -2, marginRight: 6 }} />NAS</td>
                        <td className="mono faint">{n.host}</td>
                        <td>—</td>
                        <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setAdding({ nas: n })}><Plus size={13} /> Configurer</button></td>
                      </tr>
                    ))}
                    {suggestions.guests.map((g) => (
                      <tr key={`${g.serverId}/${g.vmid}`}>
                        <td><b>{g.name}</b> <span className="faint">#{g.vmid}</span></td>
                        <td className="muted">{g.kind === 'lxc' ? <Box size={13} style={{ verticalAlign: -2, marginRight: 6 }} /> : <Monitor size={13} style={{ verticalAlign: -2, marginRight: 6 }} />}{g.kind === 'lxc' ? 'LXC' : 'VM'}</td>
                        <td className="muted">{g.node}</td>
                        <td>{g.status === 'running' ? <Badge kind="success">En marche</Badge> : <Badge>Arrêtée</Badge>}</td>
                        <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setAdding({ guest: g })}><Plus size={13} /> Configurer</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          ) : targets.length === 0 ? (
            <Card>
              <Empty icon={<TerminalSquare size={24} />} title="Aucune connexion" message="Ajoutez vos machines (VM, LXC, NAS, serveurs) pour y ouvrir un shell en un clic et suivre leurs mises à jour.">
                <div className="row" style={{ justifyContent: 'center' }}>
                  <button className="btn primary" onClick={() => setAdding({})}><Plus size={14} /> Nouvelle connexion</button>
                  {suggestionCount > 0 && <button className="btn" onClick={() => setFilter({ kind: 'suggestions' })}><Sparkles size={14} /> {suggestionCount} à configurer</button>}
                </div>
              </Empty>
            </Card>
          ) : (
            <Card className="flush">
              <table className="table">
                <thead><tr><th>Nom</th><th>Type</th><th>Adresse</th><th>Utilisateur</th><th>Système</th><th>Dossier / tags</th><th /></tr></thead>
                <tbody>
                  {shown.length === 0 && <tr><td colSpan={7} className="faint">Aucune connexion ne correspond.</td></tr>}
                  {shown.map((t) => {
                    const type = typeOf(t, nas.systems)
                    const scan = scans[t.id]
                    return (
                      <tr key={t.id} onDoubleClick={() => openShell(t)} style={{ cursor: 'default' }}>
                        <td><b>{t.name}</b>{t.vmid != null && <span className="faint"> #{t.vmid}</span>}</td>
                        <td className="muted"><span style={{ color: 'var(--accent)', verticalAlign: -3, marginRight: 7 }}>{type.icon}</span>{type.label}</td>
                        <td className="mono faint">{t.host}{t.port !== 22 ? `:${t.port}` : ''}</td>
                        <td className="muted">{users.get(t.credentialId) ?? '—'}</td>
                        <td className="muted" title={scan ? `Dernière analyse ${relative(scan.scannedAt)}` : undefined}>
                          {scan?.system ? `${scan.system.osName ?? ''} ${scan.system.osVersion ?? ''}`.trim() || scan.system.hostname : '—'}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                            {t.group && <Badge kind="info" plain>{t.group}</Badge>}
                            {t.tags.map((tag) => <span key={tag} className="tag">{tag}</span>)}
                          </div>
                        </td>
                        <td>
                          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                            <button className="btn sm" onClick={() => openShell(t)}><TerminalSquare size={13} /> Shell</button>
                            <button className="btn ghost sm icon" title="Mises à jour" onClick={() => navigate('updates')}><Wrench size={13} /></button>
                            <button className="btn ghost sm icon" title="Modifier" onClick={() => setEditing(t)}><Pencil size={13} /></button>
                            <button className="btn ghost sm icon" title="Supprimer" onClick={() => void remove(t)}><Trash2 size={13} /></button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Card>
          )}
          <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>Double-cliquez sur une connexion pour ouvrir un shell. Les sessions s’ouvrent dans le terminal en bas de la fenêtre.</div>
        </div>
      </div>

      {editing && <EditConnectionModal target={editing} groups={groups} onClose={() => setEditing(null)} />}
      {adding && (
        <AddTargetModal
          guest={adding.guest}
          initial={adding.nas ? { name: adding.nas.name, host: adding.nas.host, group: 'NAS' } : { group: adding.group ?? null }}
          onAdded={adding.nas ? addNasLinked : undefined}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  )
}

function FolderButton({ active, icon, label, count, onClick }: { active: boolean; icon: React.ReactNode; label: string; count: number; onClick: () => void }) {
  return (
    <button className={`folder${active ? ' on' : ''}`} onClick={onClick}>
      <span style={{ color: 'var(--accent)', display: 'flex' }}>{icon}</span>
      <span className="grow" style={{ textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="faint">{count}</span>
    </button>
  )
}

function EditConnectionModal({ target, groups, onClose }: { target: SshTarget; groups: string[]; onClose: () => void }) {
  const credentials = useApp((s) => s.credentials)
  const [name, setName] = useState(target.name)
  const [group, setGroup] = useState(target.group ?? '')
  const [tags, setTags] = useState(target.tags.join(', '))
  const [credentialId, setCredentialId] = useState(target.credentialId)
  const { busy, error, run } = useAction()

  const save = () => run(async () => {
    await api.updateTarget(target.id, { name, group: group.trim() || null, tags: tags.split(','), credentialId })
    await useApp.getState().reloadLists()
    useApp.getState().toast('success', 'Connexion mise à jour.')
    onClose()
  })

  return (
    <Modal
      title="Modifier la connexion"
      width={560}
      onClose={onClose}
      footer={<><span className="error">{error}</span><button className="btn" onClick={onClose}>Annuler</button><button className="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>Enregistrer</button></>}
    >
      <Field label="Nom"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="row">
        <div className="grow">
          <Field label="Dossier">
            <input className="input" list="bcenter-edit-groups" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Sans dossier" />
            <datalist id="bcenter-edit-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </Field>
        </div>
        <div className="grow"><Field label="Tags" hint="Séparés par des virgules."><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="web, prod" /></Field></div>
      </div>
      <Field label="Identifiants SSH">
        <select className="select" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
          {credentials.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.username})</option>)}
        </select>
      </Field>
      <div className="faint" style={{ fontSize: 12 }}>
        Adresse <span className="mono">{target.host}:{target.port}</span> · clé d’hôte <span className="mono">{target.hostKeyAlgorithm} SHA256:{target.hostKeyFingerprint.slice(0, 16)}…</span>.
        Pour changer d’adresse, supprimez puis recréez la connexion (la clé d’hôte doit être vérifiée à nouveau).
      </div>
    </Modal>
  )
}
