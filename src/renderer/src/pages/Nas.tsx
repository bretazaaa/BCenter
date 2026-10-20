import {
  Bell, Boxes, Cpu, Database, Download, ExternalLink, HardDrive, Link2, ListChecks, MemoryStick, Pencil, Play, Plus, Power,
  RefreshCw, RotateCw, Share2, ShieldCheck, Square, Thermometer, Trash2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { NasDraft } from '@shared/api'
import {
  NAS_KINDS, type CertificateInfo, type NasAction, type NasApp, type NasDisk, type NasKind, type NasPool, type NasProfile, type NasSnapshot, type NasTask,
} from '@shared/types'
import { confirm, useAction } from '../components/dialogs'
import { Badge, Callout, Card, Empty, Field, Modal, Progress, Segmented, Stat, Usage, type BadgeKind } from '../components/ui'
import { api } from '../lib/api'
import { bytes, formatFingerprint, pct, plural, relative, uptime } from '../lib/format'
import { attempt, useApp } from '../store'
import { AddTargetModal } from './Updates'

type Tab = 'storage' | 'shares' | 'apps' | 'tasks' | 'alerts'

const POOL_STATUS: Record<NasPool['status'], [BadgeKind, string]> = {
  healthy: ['success', 'Sain'], degraded: ['warning', 'Dégradé'], faulted: ['danger', 'En panne'], offline: ['danger', 'Hors ligne'], unknown: ['neutral', 'Inconnu'],
}
const DISK_STATUS: Record<NasDisk['health'], [BadgeKind, string]> = {
  ok: ['success', 'OK'], warning: ['warning', 'À surveiller'], failing: ['danger', 'Défaillant'], unknown: ['neutral', '—'],
}
const APP_STATUS: Record<NasApp['state'], [BadgeKind, string]> = {
  running: ['success', 'En marche'], stopped: ['neutral', 'Arrêtée'], error: ['danger', 'Erreur'], busy: ['info', 'En cours…'], unknown: ['neutral', 'Inconnu'],
}
const TASK_STATUS: Record<NasTask['state'], [BadgeKind, string]> = {
  ok: ['success', 'OK'], failed: ['danger', 'Échec'], running: ['accent', 'En cours'], never: ['neutral', 'Jamais lancée'], unknown: ['neutral', '—'],
}
const APP_KIND: Record<NasApp['kind'], string> = { app: 'Application', container: 'Conteneur', vm: 'VM', package: 'Paquet', jail: 'Jail' }
const TASK_TYPE: Record<NasTask['type'], string> = {
  snapshot: 'Snapshots', replication: 'Réplication', cloudsync: 'Cloud Sync', rsync: 'Rsync', backup: 'Sauvegarde', verify: 'Vérification',
  prune: 'Élagage', gc: 'Garbage collection', sync: 'Synchronisation', parity: 'Parité', cron: 'Tâche planifiée',
}
const KIND_GRADIENT: Record<NasKind, string> = {
  truenas: 'linear-gradient(135deg,#0095d5,#71bf44)', synology: 'linear-gradient(135deg,#4b5563,#111827)', unraid: 'linear-gradient(135deg,#f15a2c,#c0392b)',
  omv: 'linear-gradient(135deg,#5dacdf,#2f6fa8)', qnap: 'linear-gradient(135deg,#1e3a8a,#3b82f6)', pbs: 'linear-gradient(135deg,#e57000,#f59e0b)',
}

const StatusOf = ({ map, value }: { map: Record<string, [BadgeKind, string]>; value: string }) => {
  const [kind, label] = map[value] ?? ['neutral', value]
  return <Badge kind={kind}>{label}</Badge>
}

const webUrl = (n: NasProfile) => `${n.protocol}://${n.host.includes(':') ? `[${n.host}]` : n.host}:${n.port}/`

export function NasPage() {
  const { nas } = useApp()
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('bcenter.nas') ?? null)
  const [editing, setEditing] = useState<NasProfile | 'new' | null>(null)
  const [linking, setLinking] = useState<NasProfile | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const selected = nas.systems.find((s) => s.id === selectedId) ?? nas.systems[0]
  const select = (id: string) => {
    setSelectedId(id)
    localStorage.setItem('bcenter.nas', id)
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      useApp.setState({ nas: await api.refreshNas() })
    } finally {
      setRefreshing(false)
    }
  }

  const remove = async (n: NasProfile) => {
    if (await confirm({ title: 'Supprimer le NAS', danger: true, confirmText: 'Supprimer', message: `Supprimer ${n.name} de BCenter ? Ses identifiants chiffrés seront effacés. Aucune modification n’est faite sur le NAS.` })) {
      await attempt(() => api.removeNas(n.id), 'NAS supprimé.')
    }
  }

  if (nas.systems.length === 0) {
    return (
      <div className="page" style={{ display: 'grid', placeItems: 'center' }}>
        <Empty icon={<HardDrive size={24} />} title="Aucun NAS" message="Connectez votre NAS pour suivre ses volumes, disques et applications, et lancer vos tâches sans passer par son interface web.">
          <div className="faint" style={{ fontSize: 12, margin: '-4px 0 14px' }}>{Object.values(NAS_KINDS).map((k) => k.label).join(' · ')}</div>
          <button className="btn primary" onClick={() => setEditing('new')}><Plus size={14} /> Ajouter un NAS</button>
        </Empty>
        {editing && <NasModal nas={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </div>
    )
  }

  const snap = nas.snapshots.find((s) => s.nas.id === selected.id)
  return (
    <div className="page">
      <div className="page-head">
        <div><h1>NAS</h1><p>Stockage réseau : volumes, disques, partages, applications et tâches</p></div>
        <div className="actions">
          <button className="btn" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /> Actualiser</button>
          <button className="btn primary" onClick={() => setEditing('new')}><Plus size={14} /> Ajouter un NAS</button>
        </div>
      </div>

      {nas.systems.length > 1 && (
        <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(nas.systems.length, 4)}, minmax(0, 1fr))`, marginBottom: 18 }}>
          {nas.systems.map((n) => <NasTile key={n.id} nas={n} snap={nas.snapshots.find((s) => s.nas.id === n.id)} active={n.id === selected.id} onClick={() => select(n.id)} />)}
        </div>
      )}

      <NasDetail
        key={selected.id}
        nas={selected}
        snap={snap}
        onEdit={() => setEditing(selected)}
        onRemove={() => void remove(selected)}
        onLink={() => setLinking(selected)}
      />

      {editing && <NasModal nas={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {linking && <LinkNasModal nas={linking} onClose={() => setLinking(null)} />}
    </div>
  )
}

function NasTile({ nas, snap, active, onClick }: { nas: NasProfile; snap?: NasSnapshot; active: boolean; onClick: () => void }) {
  const used = snap?.pools.reduce((s, p) => s + p.used, 0) ?? 0
  const total = snap?.pools.reduce((s, p) => s + (p.kind === 'raid' ? 0 : p.total), 0) ?? 0
  const issues = snap ? snap.pools.filter((p) => p.status !== 'healthy' && p.status !== 'unknown').length + snap.disks.filter((d) => d.health === 'warning' || d.health === 'failing').length : 0
  return (
    <button className={`card clickable${active ? ' selected' : ''}`} style={{ textAlign: 'left', borderColor: active ? 'var(--accent-ring)' : undefined }} onClick={onClick}>
      <div className="row" style={{ alignItems: 'center' }}>
        <span className={`dot ${!snap ? '' : !snap.reachable ? 'bad' : issues ? 'warn' : 'ok'}`} />
        <b className="grow" style={{ fontSize: 14 }}>{nas.name}</b>
        <span className="faint" style={{ fontSize: 11.5 }}>{NAS_KINDS[nas.kind].label.split(' (')[0]}</span>
      </div>
      <div style={{ margin: '12px 0 6px' }}><Usage value={total ? used / total : 0} warn={0.8} /></div>
      <div className="faint" style={{ fontSize: 12 }}>
        {!snap ? 'Connexion…' : !snap.reachable ? 'Injoignable' : total ? `${bytes(used)} / ${bytes(total)}` : 'Aucun volume'}
        {issues > 0 && <span style={{ color: 'var(--warning)' }}> · {plural(issues, 'point')} à vérifier</span>}
      </div>
    </button>
  )
}

function NasDetail({ nas, snap, onEdit, onRemove, onLink }: {
  nas: NasProfile; snap?: NasSnapshot; onEdit: () => void; onRemove: () => void; onLink: () => void
}) {
  const targets = useApp((s) => s.targets)
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem('bcenter.nasTab') as Tab | null) ?? 'storage')
  const [busy, setBusy] = useState<string | null>(null)
  const kind = NAS_KINDS[nas.kind]
  const target = targets.find((t) => t.id === nas.sshTargetId)
  const sys = snap?.system ?? {}
  const can = (c: string) => snap?.capabilities.includes(c as never) ?? false

  const run = async (key: string, action: NasAction, ask?: Parameters<typeof confirm>[0]) => {
    if (ask && !(await confirm(ask))) return
    setBusy(key)
    try {
      const message = await api.nasAction(nas.id, action)
      useApp.getState().toast('success', message)
    } catch (error) {
      useApp.getState().toast('error', (error as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const power = (op: 'reboot' | 'shutdown') =>
    void run(`power:${op}`, { kind: 'power', op }, {
      title: op === 'reboot' ? 'Redémarrer le NAS' : 'Éteindre le NAS', danger: true, confirmText: op === 'reboot' ? 'Redémarrer' : 'Éteindre',
      message: op === 'reboot'
        ? `${nas.name} va redémarrer. Les partages, applications et machines qui utilisent ce stockage seront interrompus pendant quelques minutes.`
        : `${nas.name} va s’éteindre. Il faudra le rallumer physiquement ou par Wake-on-LAN. Les VM et services qui utilisent ce stockage seront interrompus.`,
    })

  const switchTab = (t: Tab) => {
    setTab(t)
    localStorage.setItem('bcenter.nasTab', t)
  }

  const pools = snap?.pools ?? []
  const used = pools.reduce((s, p) => s + p.used, 0)
  const total = pools.reduce((s, p) => s + (p.kind === 'raid' ? 0 : p.total), 0)
  const diskIssues = snap?.disks.filter((d) => d.health === 'warning' || d.health === 'failing').length ?? 0
  const running = snap?.apps.filter((a) => a.state === 'running').length ?? 0
  const alerts = snap?.alerts ?? []

  return (
    <>
      <div className="row" style={{ alignItems: 'center', marginBottom: 14 }}>
        <div className="icon-tile" style={{ width: 44, height: 44, borderRadius: 12, background: KIND_GRADIENT[nas.kind], color: 'white' }}><HardDrive size={20} /></div>
        <div className="grow">
          <div style={{ fontSize: 16, fontWeight: 600 }}>{nas.name} <span className="mono faint" style={{ marginLeft: 8 }}>{nas.host}:{nas.port}</span></div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
            {[sys.version?.toLowerCase().includes(kind.label.split(' ')[0].toLowerCase()) ? null : kind.label, sys.model, sys.version, sys.uptime ? `en ligne depuis ${uptime(sys.uptime)}` : null].filter(Boolean).join(' · ')}
            {'  ·  '}
            {nas.protocol === 'http' ? 'Connexion non chiffrée (HTTP)' : nas.pinnedFingerprint ? 'Certificat épinglé' : 'Certificat validé par Windows'}
          </div>
        </div>
        {kind.support === 'basic' && <Badge kind="info" plain>Prise en charge de base</Badge>}
        {snap ? <Badge kind={snap.reachable ? 'success' : 'danger'}>{snap.reachable ? 'Connecté' : 'Injoignable'}</Badge> : <Badge>Connexion…</Badge>}
        <button className="btn sm" title="Ouvrir l’interface web du NAS dans le navigateur" onClick={() => window.open(webUrl(nas))}><ExternalLink size={13} /> Interface web</button>
        {can('reboot') && <button className="btn sm" disabled={!snap?.reachable || busy != null} onClick={() => power('reboot')}><RotateCw size={13} /> Redémarrer</button>}
        {can('shutdown') && <button className="btn sm icon" title="Éteindre" disabled={!snap?.reachable || busy != null} onClick={() => power('shutdown')}><Power size={13} /></button>}
        <button className="btn ghost sm icon" title="Modifier" onClick={onEdit}><Pencil size={13} /></button>
        <button className="btn ghost sm icon" title="Supprimer" onClick={onRemove}><Trash2 size={13} /></button>
      </div>

      {snap?.error && <div className="callout danger" style={{ marginBottom: 14 }}>{snap.error}</div>}

      {sys.updates?.available && (
        <div className="callout info" style={{ marginBottom: 14, alignItems: 'center' }}>
          <Download size={16} />
          <div style={{ flex: 1 }}>
            <b>Mise à jour disponible</b>{sys.updates.version ? ` : ${sys.updates.version}` : sys.updates.count ? ` : ${plural(sys.updates.count, 'paquet')}` : ''}.
            {!can('update') && <span className="faint"> {target ? 'Installez-la depuis le centre de mises à jour (SSH) ou l’interface du NAS.' : 'Installez-la depuis l’interface du NAS.'}</span>}
          </div>
          {can('update') && (
            <button className="btn primary sm" disabled={busy != null} onClick={() => void run('update', { kind: 'update' }, {
              title: 'Mettre à jour le NAS', danger: true, confirmText: 'Installer',
              message: `La mise à jour de ${nas.name} va être téléchargée et installée${nas.kind === 'truenas' ? ', puis le NAS redémarrera' : ''}. Les services du NAS peuvent être interrompus. Vérifiez qu’aucune sauvegarde n’est en cours.`,
            })}><Download size={13} /> Installer</button>
          )}
        </div>
      )}
      {sys.rebootRequired && <div style={{ marginBottom: 14 }}><Callout kind="warning">Un redémarrage du NAS est nécessaire pour finaliser des mises à jour.</Callout></div>}

      <div className="grid kpi" style={{ marginBottom: 14 }}>
        <Stat label="Stockage" value={total ? pct(used / total) : '—'} detail={total ? `${bytes(used)} sur ${bytes(total)}` : 'Aucun volume'} icon={<Database size={18} />} />
        <Stat label="Disques" value={snap?.disks.length ?? '—'} detail={diskIssues ? `${plural(diskIssues, 'disque')} à surveiller` : 'Aucun problème détecté'}
          icon={<HardDrive size={18} />} color={diskIssues ? 'var(--warning)' : 'var(--success)'} soft={diskIssues ? 'var(--warning-soft)' : 'var(--success-soft)'} />
        <Stat label="Applications" value={snap ? `${running} / ${snap.apps.length}` : '—'} detail={`${snap?.services.filter((s) => s.running).length ?? 0} service(s) actif(s)`} icon={<Boxes size={18} />} color="var(--violet)" soft="rgba(167,139,250,0.14)" />
        <Stat label="Système" value={sys.cpu != null ? pct(sys.cpu) : sys.temperature != null ? `${sys.temperature} °C` : '—'}
          detail={[sys.memTotal ? `${sys.memUsed != null ? `${bytes(sys.memUsed)} / ` : ''}${bytes(sys.memTotal)} RAM` : null, sys.cpu != null && sys.temperature != null ? `${sys.temperature} °C` : null].filter(Boolean).join(' · ') || 'Processeur'}
          icon={sys.temperature != null && sys.cpu == null ? <Thermometer size={18} /> : sys.cpu != null ? <Cpu size={18} /> : <MemoryStick size={18} />} color="var(--accent-2)" soft="rgba(34,211,238,0.12)" />
      </div>

      <div style={{ marginBottom: 14 }}>
        <Segmented<Tab>
          value={tab}
          onChange={switchTab}
          options={[
            ['storage', `Stockage (${pools.length + (snap?.disks.length ?? 0)})`],
            ['shares', `Partages (${snap?.shares.length ?? 0})`],
            ['apps', `Services et applications (${(snap?.services.length ?? 0) + (snap?.apps.length ?? 0)})`],
            ['tasks', `Tâches (${snap?.tasks.length ?? 0})`],
            ['alerts', `Alertes (${alerts.length})`],
          ]}
        />
      </div>

      {!snap ? <Card><Progress indeterminate /></Card>
        : tab === 'storage' ? <StorageTab snap={snap} busy={busy} run={run} />
        : tab === 'shares' ? <SharesTab snap={snap} />
        : tab === 'apps' ? <AppsTab snap={snap} busy={busy} run={run} />
        : tab === 'tasks' ? <TasksTab snap={snap} busy={busy} run={run} />
        : <AlertsTab snap={snap} />}

      {!target && (
        <div className="faint" style={{ fontSize: 12, marginTop: 14 }}>
          <Link2 size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
          Associez une connexion SSH pour ouvrir un shell sur ce NAS depuis Connexions et suivre ses paquets dans le centre de mises à jour.{' '}
          <button className="btn ghost sm" style={{ height: 22 }} onClick={onLink}>Associer</button>
        </div>
      )}
    </>
  )
}

type Run = (key: string, action: NasAction, ask?: Parameters<typeof confirm>[0]) => Promise<void>

function StorageTab({ snap, busy, run }: { snap: NasSnapshot; busy: string | null; run: Run }) {
  return (
    <div className="stack">
      <Card title="Volumes et pools" subtitle="État et remplissage" className="flush">
        {snap.pools.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucun volume remonté par le NAS.</div> : (
          <table className="table">
            <thead><tr><th>Nom</th><th>Type</th><th>État</th><th style={{ width: '32%' }}>Utilisation</th><th>Scrub</th><th /></tr></thead>
            <tbody>
              {snap.pools.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b></td>
                  <td className="muted">{p.detail ?? p.kind}</td>
                  <td><span title={p.statusText}><StatusOf map={POOL_STATUS} value={p.status} /></span></td>
                  <td>
                    {p.kind === 'raid' ? <span className="muted">{bytes(p.total)}</span> : (
                      <div className="row" style={{ alignItems: 'center' }}>
                        <div className="grow"><Usage value={p.total ? p.used / p.total : 0} warn={0.8} /></div>
                        <span className="muted" style={{ fontSize: 12, width: 140, textAlign: 'right' }}>{bytes(p.used)} / {bytes(p.total)}</span>
                      </div>
                    )}
                  </td>
                  <td className="muted">
                    {p.scrub ? (p.scrub.running ? <Badge kind="accent">En cours</Badge> : <>{relative(p.scrub.lastRun)}{p.scrub.errors ? <span style={{ color: 'var(--danger)' }}> · {p.scrub.errors} erreur(s)</span> : null}</>) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {p.canScrub && (
                      <button className="btn sm" disabled={busy != null || p.scrub?.running} onClick={() => void run(`scrub:${p.id}`, { kind: 'scrub', poolId: p.id }, {
                        title: 'Lancer un scrub', confirmText: 'Lancer',
                        message: `Le scrub vérifie l’intégrité de toutes les données de ${p.name}. Il peut durer plusieurs heures et ralentir le NAS pendant ce temps.`,
                      })}><ShieldCheck size={13} /> Scrub</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Disques" subtitle="Santé, température et affectation" className="flush">
        {snap.disks.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucun disque remonté par le NAS.</div> : (
          <table className="table">
            <thead><tr><th>Disque</th><th>Modèle</th><th>N° de série</th><th>Capacité</th><th>Température</th><th>Pool</th><th>Santé</th></tr></thead>
            <tbody>
              {snap.disks.map((d) => (
                <tr key={d.id}>
                  <td><b>{d.name}</b></td>
                  <td className="muted">{d.model ?? '—'}</td>
                  <td className="mono faint">{d.serial ?? '—'}</td>
                  <td className="muted">{d.size ? bytes(d.size) : '—'}</td>
                  <td style={{ color: d.temperature != null && d.temperature >= 50 ? 'var(--warning)' : undefined }}>{d.temperature != null ? `${d.temperature} °C` : <span className="faint">—</span>}</td>
                  <td className="muted">{d.pool ?? '—'}</td>
                  <td><span title={d.healthText}><StatusOf map={DISK_STATUS} value={d.health} /></span>{d.health !== 'ok' && d.healthText && d.health !== 'unknown' && <span className="faint" style={{ fontSize: 12, marginLeft: 8 }}>{d.healthText}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function SharesTab({ snap }: { snap: NasSnapshot }) {
  return (
    <Card title="Partages" subtitle="Dossiers partagés sur le réseau" className="flush">
      {snap.shares.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucun partage remonté par le NAS.</div> : (
        <table className="table">
          <thead><tr><th>Nom</th><th>Protocole</th><th>Chemin</th><th>Description</th><th>État</th></tr></thead>
          <tbody>
            {snap.shares.map((s) => (
              <tr key={s.id}>
                <td><Share2 size={13} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--accent)' }} /><b>{s.name}</b></td>
                <td><Badge kind="info" plain>{s.protocol}</Badge></td>
                <td className="mono faint">{s.path ?? '—'}</td>
                <td className="muted">{s.comment ?? ''}</td>
                <td>{s.enabled ? <Badge kind="success">Actif</Badge> : <Badge>Désactivé</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function ControlButtons({ id, running, busy, onRun }: { id: string; running: boolean; busy: string | null; onRun: (op: 'start' | 'stop' | 'restart') => void }) {
  const disabled = busy != null
  return (
    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      {busy?.endsWith(id) && <RefreshCw size={13} className="spin" style={{ alignSelf: 'center', marginRight: 6, color: 'var(--accent)' }} />}
      {!running && <button className="btn sm" disabled={disabled} onClick={() => onRun('start')}><Play size={12} /> Démarrer</button>}
      {running && <button className="btn sm icon" title="Redémarrer" disabled={disabled} onClick={() => onRun('restart')}><RotateCw size={12} /></button>}
      {running && <button className="btn sm icon" title="Arrêter" disabled={disabled} onClick={() => onRun('stop')}><Square size={12} /></button>}
    </div>
  )
}

function AppsTab({ snap, busy, run }: { snap: NasSnapshot; busy: string | null; run: Run }) {
  const stopAsk = (name: string, what: string) => ({
    title: `Arrêter ${what}`, danger: true, confirmText: 'Arrêter',
    message: `Arrêter ${name} sur ${snap.nas.name} ? Les utilisateurs et machines qui en dépendent perdront l’accès jusqu’à son redémarrage.`,
  })
  const apps = useMemo(() => [...snap.apps].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)), [snap.apps])
  return (
    <div className="stack">
      <Card title="Services" subtitle="Services de partage et système du NAS" className="flush">
        {snap.services.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucun service remonté par le NAS.</div> : (
          <table className="table">
            <thead><tr><th>Service</th><th>État</th><th>Au démarrage</th><th /></tr></thead>
            <tbody>
              {snap.services.map((s) => (
                <tr key={s.id}>
                  <td><b>{s.name}</b></td>
                  <td>{s.running ? <Badge kind="success">En marche</Badge> : <Badge>Arrêté</Badge>}</td>
                  <td className="muted">{s.enabled == null ? '—' : s.enabled ? 'Automatique' : 'Manuel'}</td>
                  <td>
                    {s.controllable ? (
                      <ControlButtons id={`svc:${s.id}`} running={s.running} busy={busy}
                        onRun={(op) => void run(`${op}:svc:${s.id}`, { kind: 'service', id: s.id, op }, op === 'stop' ? stopAsk(`le service ${s.name}`, 'le service') : undefined)} />
                    ) : <div className="faint" style={{ textAlign: 'right', fontSize: 12 }}>Lecture seule</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Applications" subtitle="Applications, conteneurs, paquets et VM hébergés par le NAS" className="flush">
        {apps.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucune application remontée par le NAS.</div> : (
          <table className="table">
            <thead><tr><th>Nom</th><th>Type</th><th>Version / image</th><th>État</th><th /></tr></thead>
            <tbody>
              {apps.map((a) => (
                <tr key={a.id}>
                  <td><b>{a.name}</b>{a.updateAvailable && <span style={{ marginLeft: 8 }}><Badge kind="info" plain>Mise à jour</Badge></span>}</td>
                  <td className="muted">{APP_KIND[a.kind]}</td>
                  <td className="mono faint" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.version ?? '—'}</td>
                  <td><span title={a.stateText}><StatusOf map={APP_STATUS} value={a.state} /></span></td>
                  <td>
                    {a.controllable && (
                      <ControlButtons id={`app:${a.id}`} running={a.state === 'running' || a.state === 'busy'} busy={busy}
                        onRun={(op) => void run(`${op}:app:${a.id}`, { kind: 'app', id: a.id, op }, op === 'stop' ? stopAsk(a.name, a.kind === 'vm' ? 'la VM' : 'l’application') : undefined)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function TasksTab({ snap, busy, run }: { snap: NasSnapshot; busy: string | null; run: Run }) {
  return (
    <Card title="Tâches de données" subtitle="Snapshots, réplications, synchronisations et sauvegardes configurées sur le NAS" className="flush">
      {snap.tasks.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}>Aucune tâche configurée sur le NAS.</div> : (
        <table className="table">
          <thead><tr><th>Tâche</th><th>Type</th><th>Détail</th><th>Dernière exécution</th><th>Résultat</th><th /></tr></thead>
          <tbody>
            {snap.tasks.map((t) => (
              <tr key={t.id} style={{ opacity: t.enabled ? 1 : 0.6 }}>
                <td><ListChecks size={13} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--accent)' }} /><b>{t.name}</b>{!t.enabled && <span className="faint" style={{ marginLeft: 8, fontSize: 12 }}>désactivée</span>}</td>
                <td className="muted">{TASK_TYPE[t.type]}</td>
                <td className="mono faint" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.detail ?? ''}</td>
                <td className="muted">{relative(t.lastRun)}</td>
                <td><StatusOf map={TASK_STATUS} value={t.state} /></td>
                <td style={{ textAlign: 'right' }}>
                  {t.canRun && (
                    <button className="btn sm" disabled={busy != null} onClick={() => void run(`task:${t.id}`, { kind: 'task', id: t.id })}>
                      {busy === `task:${t.id}` ? <RefreshCw size={12} className="spin" /> : <Play size={12} />} Lancer
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

function AlertsTab({ snap }: { snap: NasSnapshot }) {
  const level: Record<string, [BadgeKind, string]> = { critical: ['danger', 'Critique'], warning: ['warning', 'Avertissement'], info: ['info', 'Info'] }
  return (
    <Card title="Alertes du NAS" subtitle="Remontées par le NAS ; les alertes importantes apparaissent aussi dans Alertes et en notification Windows" className="flush">
      {snap.alerts.length === 0 ? <div className="faint" style={{ padding: '0 18px 16px' }}><Bell size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Aucune alerte active.</div> : (
        <table className="table">
          <thead><tr><th style={{ width: 130 }}>Niveau</th><th>Message</th><th style={{ width: 140 }}>Depuis</th></tr></thead>
          <tbody>
            {snap.alerts.map((a) => (
              <tr key={a.id}>
                <td><StatusOf map={level} value={a.level} /></td>
                <td className="selectable">{a.message}</td>
                <td className="muted">{relative(a.time)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ Ajout / modification

const KIND_HELP: Record<NasKind, React.ReactNode> = {
  truenas: <>Créez une clé API : menu utilisateur (en haut à droite) › <b>Clés API</b> › Ajouter. HTTPS est obligatoire : TrueNAS révoque une clé utilisée sans chiffrement.</>,
  synology: <>Compte du groupe <b>administrators</b>, idéalement dédié à BCenter. Si la validation en deux étapes est active, un code sera demandé une seule fois, puis BCenter sera enregistré comme appareil de confiance.</>,
  unraid: <>Unraid 7.2 et suivants (ou plugin Unraid Connect) : <b>Paramètres › Management Access › API Keys</b>. Rôle <b>ADMIN</b> pour les actions, <b>VIEWER</b> pour la lecture seule.</>,
  omv: <>Compte administrateur de l’interface web (par défaut <b>admin</b>). Activez HTTPS dans Système › Paramètres de l’espace de travail si ce n’est pas déjà fait.</>,
  qnap: <>Compte administrateur sans validation en deux étapes. Prise en charge de base : état du système, volumes, disques, redémarrage et arrêt.</>,
  pbs: <>Jeton API : <b>Configuration › Access Control › API Token</b> (format utilisateur@realm!nom). Rôle <b>Audit</b> sur / pour la lecture ; <b>Datastore.Modify</b>, <b>Sys.Modify</b> et <b>Sys.PowerManagement</b> pour les actions.</>,
}

type FormState = 'idle' | 'testing' | 'approval' | 'otp' | 'success' | 'failed'

export function NasModal({ nas, onClose }: { nas?: NasProfile; onClose: () => void }) {
  const [kind, setKindRaw] = useState<NasKind>(nas?.kind ?? 'truenas')
  const [name, setName] = useState(nas?.name ?? '')
  const [host, setHostRaw] = useState(nas?.host ?? '')
  const [protocol, setProtocolRaw] = useState<'https' | 'http'>(nas?.protocol ?? 'https')
  const [port, setPortRaw] = useState(String(nas?.port ?? NAS_KINDS.truenas.defaultPort))
  const [portTouched, setPortTouched] = useState(!!nas)
  const [username, setUsernameRaw] = useState(nas?.username ?? '')
  const [secret, setSecretRaw] = useState('')
  const [otp, setOtp] = useState('')
  const [certificate, setCertificate] = useState<CertificateInfo | null>(null)
  const [approved, setApproved] = useState(!!nas?.pinnedFingerprint)
  const [state, setState] = useState<FormState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const { busy, error, run } = useAction()
  const info = NAS_KINDS[kind]

  const reset = (cert: boolean) => {
    setState('idle')
    setMessage(null)
    if (cert) {
      setCertificate(null)
      setApproved(false)
    }
  }
  const setKind = (k: NasKind) => {
    setKindRaw(k)
    if (!portTouched) {
      setPortRaw(String(NAS_KINDS[k].defaultPort))
      setProtocolRaw(NAS_KINDS[k].defaultProtocol)
    }
    if (k === 'pbs' && !username) setUsernameRaw('bcenter@pbs!bcenter')
    reset(true)
  }
  const setHost = (v: string) => { setHostRaw(v); reset(true) }
  const setPort = (v: string) => { setPortRaw(v); setPortTouched(true); reset(true) }
  const setProtocol = (v: 'https' | 'http') => {
    setProtocolRaw(v)
    if (!portTouched) setPortRaw(v === 'http' ? '80' : String(info.defaultPort))
    reset(true)
  }
  const setUsername = (v: string) => { setUsernameRaw(v); reset(false) }
  const setSecret = (v: string) => { setSecretRaw(v); reset(false) }

  const draft = (cert = certificate, trust = approved): NasDraft => ({
    id: nas?.id, name: name.trim() || host.trim(), kind, host: host.trim(), port: Number(port), protocol,
    username: info.auth === 'apiKey' ? null : username.trim(), secret: secret.trim() && info.auth !== 'password' ? secret.trim() : secret,
    otp: otp.trim() || undefined,
    pinnedFingerprint: protocol === 'https' ? (cert && !cert.trustedBySystem && trust ? cert.fingerprint : cert ? null : nas?.pinnedFingerprint ?? null) : null,
  })

  const validate = (): string | null => {
    if (!/^[a-z0-9.\-:[\]]+$/i.test(host.trim())) return 'Adresse du NAS invalide.'
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port invalide.'
    if (kind === 'truenas' && protocol !== 'https') return 'TrueNAS exige HTTPS pour l’utilisation des clés API.'
    if (info.auth !== 'apiKey' && !username.trim()) return info.auth === 'token' ? 'Saisissez l’identifiant du jeton API.' : 'Saisissez le nom d’utilisateur.'
    if (info.auth === 'token' && !/^[^@\s]+@[^!\s]+![^\s]+$/.test(username.trim())) return 'L’identifiant du jeton doit être au format utilisateur@realm!nom.'
    if (!secret && !nas) return info.auth === 'password' ? 'Saisissez le mot de passe.' : 'Saisissez la clé API.'
    return null
  }

  const test = async (trust = approved) => {
    const invalid = validate()
    if (invalid) {
      setState('failed')
      setMessage(invalid)
      return
    }
    setState('testing')
    try {
      let cert = certificate
      if (protocol === 'https') {
        setMessage('Vérification du certificat TLS…')
        cert = await api.probeCertificate(host.trim(), Number(port))
        const keep = trust && (certificate?.fingerprint === cert.fingerprint || nas?.pinnedFingerprint === cert.fingerprint)
        setCertificate(cert)
        setApproved(keep)
        if (!cert.trustedBySystem && !keep) {
          setState('approval')
          setMessage('Ce certificat n’est pas reconnu par Windows (certificat auto-signé du NAS). Comparez son empreinte avec celle affichée dans l’interface du NAS avant de l’approuver.')
          return
        }
        trust = keep
      }
      setMessage('Connexion au NAS…')
      const result = await api.testNas(draft(cert, trust))
      if ('otpRequired' in result) {
        setState('otp')
        setMessage('Ce compte utilise la validation en deux étapes : saisissez le code de votre application d’authentification puis relancez le test.')
        return
      }
      setState('success')
      setMessage(`Connexion réussie — ${result.version}.`)
    } catch (e) {
      setState('failed')
      setMessage((e as Error).message)
    }
  }

  const save = () => run(async () => {
    const saved = await api.saveNas(draft())
    useApp.setState({ nas: await api.getNas() })
    useApp.getState().toast('success', `${saved.name} enregistré. Première lecture en cours…`)
    onClose()
  })

  return (
    <Modal
      title={nas ? 'Modifier le NAS' : 'Ajouter un NAS'}
      width={680}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error ?? (state !== 'success' ? 'Testez la connexion pour pouvoir enregistrer.' : '')}</span>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={state !== 'success' || busy} onClick={() => void save()}>Enregistrer</button>
        </>
      }
    >
      <div className="row">
        <div className="grow">
          <Field label="Système">
            <select className="select" value={kind} disabled={!!nas} onChange={(e) => setKind(e.target.value as NasKind)}>
              {(Object.keys(NAS_KINDS) as NasKind[]).map((k) => <option key={k} value={k}>{NAS_KINDS[k].label}{NAS_KINDS[k].support === 'basic' ? ' — prise en charge de base' : ''}</option>)}
            </select>
          </Field>
        </div>
        <div className="grow"><Field label="Nom affiché"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={info.label.split(' (')[0]} /></Field></div>
      </div>
      <div className="row">
        <div className="grow"><Field label="Adresse du NAS"><input className="input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="nas.mondomaine.lan ou 192.168.1.50" autoFocus /></Field></div>
        <div style={{ width: 120 }}>
          <Field label="Protocole">
            <select className="select" value={protocol} onChange={(e) => setProtocol(e.target.value as 'https' | 'http')}>
              <option value="https">HTTPS</option>
              <option value="http" disabled={kind === 'truenas'}>HTTP</option>
            </select>
          </Field>
        </div>
        <div style={{ width: 100 }}><Field label="Port"><input className="input" value={port} onChange={(e) => setPort(e.target.value)} /></Field></div>
      </div>
      {info.auth !== 'apiKey' && (
        <Field label={info.auth === 'token' ? 'Identifiant du jeton API' : 'Nom d’utilisateur'}>
          <input className={`input${info.auth === 'token' ? ' mono' : ''}`} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={info.auth === 'token' ? 'bcenter@pbs!bcenter' : 'admin'} />
        </Field>
      )}
      <Field
        label={info.auth === 'password' ? 'Mot de passe' : info.auth === 'token' ? 'Secret du jeton API' : 'Clé API'}
        hint={nas ? 'Laissez vide pour conserver le secret actuel.' : 'Chiffré avec Windows DPAPI : jamais écrit en clair ni journalisé.'}
      >
        <input className="input mono" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} />
      </Field>
      {state === 'otp' && (
        <Field label="Code de validation en deux étapes" hint="Demandé une seule fois : BCenter est ensuite enregistré comme appareil de confiance.">
          <input className="input mono" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="123456" autoFocus />
        </Field>
      )}
      <Callout>{KIND_HELP[kind]}</Callout>
      {protocol === 'http' && <div style={{ marginTop: 10 }}><Callout kind="warning">Connexion non chiffrée : le mot de passe ou la clé circule en clair sur le réseau. Préférez HTTPS.</Callout></div>}

      <div className="card" style={{ background: 'var(--panel-2)', marginTop: 16 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="icon-tile">{state === 'testing' ? <RefreshCw size={17} className="spin" /> : <ShieldCheck size={17} />}</div>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Connexion à {host || '…'}</div>
            <div className="muted" style={{ marginTop: 3, color: state === 'failed' ? 'var(--danger)' : state === 'success' ? 'var(--success)' : undefined }}>
              {message ?? 'Lancez le test pour vérifier le certificat et les identifiants.'}
            </div>
          </div>
          <button className="btn" onClick={() => void test()} disabled={state === 'testing'}><RefreshCw size={14} /> Tester</button>
        </div>
        {state === 'testing' && <div style={{ marginTop: 12 }}><Progress indeterminate /></div>}
        {certificate && (
          <dl className="kv" style={{ marginTop: 14 }}>
            <dt>Sujet</dt><dd>{certificate.subject}</dd>
            <dt>Émetteur</dt><dd>{certificate.issuer}</dd>
            <dt>SHA-256</dt><dd className="mono">{formatFingerprint(certificate.fingerprint)}</dd>
            <dt>Statut</dt><dd>{certificate.trustedBySystem ? 'Approuvé par Windows' : approved ? 'Empreinte approuvée' : 'Non reconnu par Windows'}</dd>
          </dl>
        )}
        {state === 'approval' && (
          <div className="callout warning" style={{ marginTop: 14, alignItems: 'center' }}>
            <div style={{ flex: 1 }}>N’approuvez cette empreinte que si elle correspond au certificat du NAS. BCenter refusera ensuite tout autre certificat pour ce NAS.</div>
            <button className="btn primary" onClick={() => { setApproved(true); void test(true) }}><ShieldCheck size={14} /> Approuver l’empreinte</button>
          </div>
        )}
      </div>
    </Modal>
  )
}

/** Associe une connexion SSH au NAS (shell depuis Connexions, mises à jour des paquets). */
function LinkNasModal({ nas, onClose }: { nas: NasProfile; onClose: () => void }) {
  const { targets } = useApp()
  const guess = targets.find((t) => t.host === nas.host) ?? targets.find((t) => t.name.toLowerCase() === nas.name.toLowerCase())
  const [targetId, setTargetId] = useState(nas.sshTargetId ?? guess?.id ?? '')
  const [adding, setAdding] = useState(false)
  const { busy, error, run } = useAction()

  const link = (id: string | null) => run(async () => {
    await api.linkNasTarget(nas.id, id)
    useApp.setState({ nas: await api.getNas() })
    const target = useApp.getState().targets.find((t) => t.id === id)
    useApp.getState().toast('success', target ? `${nas.name} est associé à la connexion ${target.name}.` : `${nas.name} n’est plus associé à une connexion SSH.`)
    onClose()
  })

  if (adding) {
    return (
      <AddTargetModal
        initial={{ name: nas.name, host: nas.host }}
        onAdded={async (t) => {
          await api.linkNasTarget(nas.id, t.id)
          useApp.setState({ nas: await api.getNas() })
        }}
        onClose={onClose}
      />
    )
  }

  return (
    <Modal
      title="Connexion SSH du NAS"
      width={540}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error}</span>
          {nas.sshTargetId && <button className="btn ghost" disabled={busy} onClick={() => void link(null)}>Dissocier</button>}
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={!targetId || busy} onClick={() => void link(targetId)}><Link2 size={14} /> Associer</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>Choisissez la connexion SSH correspondant à <b>{nas.name}</b> ({nas.host}). Activez d’abord le service SSH sur le NAS si nécessaire.</p>
      <Field label="Connexion SSH">
        <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">— Choisir —</option>
          {targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.host})</option>)}
        </select>
      </Field>
      <button className="btn outline-accent" onClick={() => setAdding(true)}><Plus size={14} /> Créer une connexion SSH pour ce NAS</button>
    </Modal>
  )
}
