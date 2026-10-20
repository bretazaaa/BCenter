import { Download, FolderOpen, HardDrive, KeyRound, Network, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NAS_KINDS, type AppSettings, type NasProfile, type ServerProfile } from '@shared/types'
import { confirm } from '../components/dialogs'
import { CredentialModal, ServerModal } from '../components/modals'
import { Card, Field, SettingRow, Switch } from '../components/ui'
import { api } from '../lib/api'
import { NasModal } from './Nas'
import { attempt, useApp } from '../store'

export function SettingsPage() {
  const { settings: saved, servers, credentials, version, appUpdate, saveSettings, reloadLists } = useApp()
  const [draft, setDraft] = useState<AppSettings>(saved!)
  const [serverModal, setServerModal] = useState<ServerProfile | 'new' | null>(null)
  const [credentialModal, setCredentialModal] = useState(false)
  const [nasModal, setNasModal] = useState<NasProfile | 'new' | null>(null)
  const nas = useApp((s) => s.nas)
  const [dataDir, setDataDir] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)
  const patch = (p: Partial<AppSettings>) => setDraft((d) => ({ ...d, ...p }))

  useEffect(() => {
    void api.appInfo().then((i) => setDataDir(i.dataDir))
  }, [])

  const removeServer = async (s: ServerProfile) => {
    if (await confirm({ title: 'Supprimer le serveur', danger: true, confirmText: 'Supprimer', message: `Supprimer ${s.name} de BCenter ? Le jeton API chiffré sera effacé. Aucune modification n’est faite sur le serveur.` })) {
      await attempt(() => api.removeServer(s.id), 'Serveur supprimé.')
      await reloadLists()
    }
  }

  const removeNas = async (n: NasProfile) => {
    if (await confirm({ title: 'Supprimer le NAS', danger: true, confirmText: 'Supprimer', message: `Supprimer ${n.name} de BCenter ? Ses identifiants chiffrés seront effacés. Aucune modification n’est faite sur le NAS.` })) {
      await attempt(() => api.removeNas(n.id), 'NAS supprimé.')
    }
  }

  const removeCredential = async (id: string, name: string) => {
    if (await confirm({ title: 'Supprimer les identifiants', danger: true, confirmText: 'Supprimer', message: `Supprimer « ${name} » et ses secrets chiffrés ?` })) {
      await attempt(() => api.removeCredential(id), 'Identifiants supprimés.')
      await reloadLists()
    }
  }

  const updateText =
    appUpdate.state === 'checking' ? 'Recherche de mises à jour…'
      : appUpdate.state === 'none' ? `BCenter ${version} est à jour.`
      : appUpdate.state === 'available' ? `Version ${appUpdate.version} disponible, téléchargement…`
      : appUpdate.state === 'downloading' ? `Téléchargement de la version ${appUpdate.version} : ${appUpdate.percent ?? 0} %`
      : appUpdate.state === 'ready' ? `Version ${appUpdate.version} prête à être installée.`
      : appUpdate.state === 'error' ? `Vérification impossible : ${appUpdate.message}` : ''

  return (
    <div className="page" style={{ paddingBottom: 90 }}>
      <div className="page-head"><div><h1>Réglages</h1><p>Préférences, serveurs et sécurité</p></div></div>

      <div className="grid halves" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Card title="Général" subtitle="Langue et comportement de l’application">
            <Field label="Langue">
              <select className="select" value={draft.language} onChange={(e) => patch({ language: e.target.value })}>
                <option value="fr-FR">Français</option>
                <option value="en-US">English (interface en cours de traduction)</option>
              </select>
            </Field>
            <SettingRow title="Lancer au démarrage de Windows"><Switch checked={draft.startWithWindows} onChange={(v) => patch({ startWithWindows: v })} /></SettingRow>
            <SettingRow title="Démarrer réduit dans la zone de notification"><Switch checked={draft.startMinimized} disabled={!draft.startWithWindows} onChange={(v) => patch({ startMinimized: v })} /></SettingRow>
            <SettingRow title="Continuer en arrière-plan à la fermeture" description="Quitter complètement depuis l’icône de la zone de notification.">
              <Switch checked={draft.minimizeToTray} onChange={(v) => patch({ minimizeToTray: v })} />
            </SettingRow>
            <SettingRow title="Notifications Windows"><Switch checked={draft.notifications} onChange={(v) => patch({ notifications: v })} /></SettingRow>
          </Card>

          <Card title="Surveillance et alertes" subtitle="Fréquence d’actualisation et seuils">
            <Field label="Intervalle d’actualisation">
              <select className="select" value={draft.refreshInterval} onChange={(e) => patch({ refreshInterval: Number(e.target.value) })}>
                {[5, 10, 15, 30, 60, 120].map((v) => <option key={v} value={v}>{v} secondes</option>)}
              </select>
            </Field>
            <div className="row">
              {(['cpuThreshold', 'memThreshold', 'storageThreshold'] as const).map((k, i) => (
                <div className="grow" key={k}>
                  <Field label={['Seuil CPU', 'Seuil mémoire', 'Seuil stockage'][i]}>
                    <select className="select" value={Math.round(draft[k] * 100)} onChange={(e) => patch({ [k]: Number(e.target.value) / 100 })}>
                      {[70, 75, 80, 85, 90, 95].map((v) => <option key={v} value={v}>{v} %</option>)}
                    </select>
                  </Field>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Maintenance" subtitle="Règles appliquées aux mises à jour">
            <SettingRow title="Snapshot Proxmox avant mise à jour" description="Vos sauvegardes NAS / Proxmox Backup Server restent gérées par Proxmox.">
              <Switch checked={draft.snapshotBeforeUpdate} onChange={(v) => patch({ snapshotBeforeUpdate: v })} />
            </SettingRow>
            <SettingRow title="Conservation des snapshots BCenter" description="Seuls les snapshots créés par BCenter (bcenter-…) sont supprimés.">
              <select className="select" style={{ width: 130 }} value={draft.snapshotRetentionDays} onChange={(e) => patch({ snapshotRetentionDays: Number(e.target.value) })}>
                {[1, 3, 7, 14, 30].map((v) => <option key={v} value={v}>{v} jour{v > 1 ? 's' : ''}</option>)}
              </select>
            </SettingRow>
            <SettingRow title="Tâches simultanées" description="Nombre de machines mises à jour en parallèle.">
              <select className="select" style={{ width: 130 }} value={draft.maxParallelJobs} onChange={(e) => patch({ maxParallelJobs: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </SettingRow>
          </Card>
        </div>

        <div className="stack">
          <Card title="Serveurs Proxmox" subtitle="Jetons API chiffrés avec Windows DPAPI" actions={<button className="btn primary sm" onClick={() => setServerModal('new')}><Plus size={13} /> Ajouter</button>}>
            {servers.length === 0 && <div className="faint">Aucun serveur enregistré.</div>}
            {servers.map((s) => (
              <SettingRow key={s.id} title={<span><Network size={14} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--accent)' }} />{s.name}</span>} description={`${s.host}:${s.port} · ${s.tokenId}`}>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn ghost sm icon" title="Modifier" onClick={() => setServerModal(s)}><Pencil size={13} /></button>
                  <button className="btn ghost sm icon" title="Supprimer" onClick={() => void removeServer(s)}><Trash2 size={13} /></button>
                </div>
              </SettingRow>
            ))}
          </Card>

          <Card title="NAS" subtitle="Clés et mots de passe chiffrés avec Windows DPAPI" actions={<button className="btn sm" onClick={() => setNasModal('new')}><Plus size={13} /> Ajouter</button>}>
            {nas.systems.length === 0 && <div className="faint">Aucun NAS enregistré.</div>}
            {nas.systems.map((n) => (
              <SettingRow key={n.id} title={<span><HardDrive size={14} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--accent-2)' }} />{n.name}</span>} description={`${NAS_KINDS[n.kind].label} · ${n.host}:${n.port}${n.username ? ` · ${n.username}` : ''}`}>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn ghost sm icon" title="Modifier" onClick={() => setNasModal(n)}><Pencil size={13} /></button>
                  <button className="btn ghost sm icon" title="Supprimer" onClick={() => void removeNas(n)}><Trash2 size={13} /></button>
                </div>
              </SettingRow>
            ))}
          </Card>

          <Card title="Identifiants SSH" subtitle="Utilisés pour la maintenance des machines" actions={<button className="btn sm" onClick={() => setCredentialModal(true)}><Plus size={13} /> Ajouter</button>}>
            {credentials.length === 0 && <div className="faint">Aucun identifiant enregistré.</div>}
            {credentials.map((c) => (
              <SettingRow key={c.id} title={<span><KeyRound size={14} style={{ verticalAlign: -2, marginRight: 8, color: 'var(--violet)' }} />{c.name}</span>} description={`${c.username} · ${c.authMethod === 'key' ? 'clé privée' : 'mot de passe'}`}>
                <span className="muted" style={{ fontSize: 12 }} title="Exécuter les commandes de maintenance avec sudo (sans mot de passe) quand l’utilisateur n’est pas root">sudo</span>
                <Switch checked={c.useSudo} onChange={(v) => void attempt(async () => { await api.setCredentialSudo(c.id, v); await reloadLists() })} />
                <button className="btn ghost sm icon" title="Supprimer" onClick={() => void removeCredential(c.id, c.name)}><Trash2 size={13} /></button>
              </SettingRow>
            ))}
          </Card>

          <Card title="Mises à jour de BCenter" subtitle={`Version installée : ${version}`}>
            <SettingRow title="Vérifier et télécharger automatiquement"><Switch checked={draft.checkForUpdates} onChange={(v) => patch({ checkForUpdates: v })} /></SettingRow>
            <SettingRow title="Source des mises à jour" description="Versions publiées dans les Releases du dépôt GitHub du projet.">
              <button className="btn ghost sm" onClick={() => window.open('https://github.com/bretazaaa/BCenter/releases')}>github.com/bretazaaa/BCenter</button>
            </SettingRow>
            <SettingRow title="Code source" description="BCenter est un logiciel libre, distribué sous licence GNU GPL v3.">
              <button className="btn ghost sm" onClick={() => window.open('https://github.com/bretazaaa/BCenter')}>Voir sur GitHub</button>
            </SettingRow>
            <div className="row" style={{ alignItems: 'center' }}>
              <button className="btn" onClick={() => void attempt(() => api.checkAppUpdate())}><RefreshCw size={14} /> Vérifier maintenant</button>
              {appUpdate.state === 'ready' && <button className="btn primary" onClick={() => void api.installAppUpdate()}><Download size={14} /> Redémarrer et installer</button>}
              <span className="muted" style={{ fontSize: 12 }}>{updateText}</span>
            </div>
          </Card>

          <Card title="Données locales" subtitle="Base SQLite, journaux et secrets chiffrés">
            <div className="row">
              <input className="input mono grow" readOnly value={dataDir} />
              <button className="btn" onClick={() => void api.openPath('data')}><FolderOpen size={14} /> Ouvrir</button>
            </div>
          </Card>
        </div>
      </div>

      {dirty && (
        <div style={{ position: 'sticky', bottom: -10, marginTop: 18, display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderRadius: 12, background: 'var(--panel-2)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)' }}>
          <span className="muted">Modifications non enregistrées</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={() => setDraft(saved!)}>Annuler</button>
          <button className="btn primary" onClick={() => void attempt(() => saveSettings(draft), 'Réglages enregistrés.')}>Enregistrer</button>
        </div>
      )}

      {serverModal && <ServerModal server={serverModal === 'new' ? undefined : serverModal} onClose={() => setServerModal(null)} />}
      {credentialModal && <CredentialModal onClose={() => setCredentialModal(false)} />}
      {nasModal && <NasModal nas={nasModal === 'new' ? undefined : nasModal} onClose={() => setNasModal(null)} />}
    </div>
  )
}
