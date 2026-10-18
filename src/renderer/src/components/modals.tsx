import { BookOpen, Heart, KeyRound, Network, Wrench } from 'lucide-react'
import type { ServerProfile } from '@shared/types'
import { api } from '../lib/api'
import { useApp } from '../store'
import { useAction } from './dialogs'
import { ServerFields, ServerTest, SshFields, useServerForm, useSshForm } from './forms'
import { Modal } from './ui'

export function ServerModal({ server, onClose }: { server?: ServerProfile; onClose: () => void }) {
  const form = useServerForm(server)
  const { busy, error, run } = useAction()
  const save = () =>
    run(async () => {
      await api.saveServer(form.draft())
      await useApp.getState().reloadLists()
      useApp.getState().toast('success', `Serveur ${form.name} enregistré.`)
      onClose()
    })
  return (
    <Modal
      title={server ? 'Modifier le serveur' : 'Ajouter un serveur Proxmox'}
      width={660}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error ?? (!form.verified ? 'Testez la connexion pour pouvoir enregistrer.' : '')}</span>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={!form.verified || busy} onClick={() => void save()}>Enregistrer</button>
        </>
      }
    >
      <ServerFields form={form} />
      <div style={{ height: 16 }} />
      <ServerTest form={form} />
    </Modal>
  )
}

export function CredentialModal({ onClose }: { onClose: () => void }) {
  const form = useSshForm()
  const { busy, error, run } = useAction()
  const save = () =>
    run(async () => {
      const credential = await api.saveCredential(form.draft())
      if (form.tested && form.addTested && form.hostKey) {
        await api.addTarget({ name: form.system?.hostname ?? form.testHost, host: form.testHost, port: Number(form.testPort), credentialId: credential.id, hostKey: form.hostKey, guest: null })
      }
      await useApp.getState().reloadLists()
      useApp.getState().toast('success', 'Identifiants SSH enregistrés.')
      onClose()
    })
  return (
    <Modal
      title="Ajouter des identifiants SSH"
      width={660}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error}</span>
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn primary" disabled={!form.valid || busy} onClick={() => void save()}>Enregistrer</button>
        </>
      }
    >
      <SshFields form={form} />
    </Modal>
  )
}

/** Fenêtre d'accueil affichée une fois par version (à la manière de « Quoi de neuf »). */
export function WelcomeModal({ onClose }: { onClose: () => void }) {
  const { version, navigate } = useApp()
  const go = (page: Parameters<typeof navigate>[0]) => {
    navigate(page)
    onClose()
  }
  return (
    <Modal
      title="Bienvenue sur BCenter"
      width={560}
      onClose={onClose}
      footer={<><span className="spacer" /><button className="btn primary" onClick={onClose}>C’est parti</button></>}
    >
      <div className="row" style={{ alignItems: 'center', marginBottom: 16 }}>
        <div className="icon-tile" style={{ width: 44, height: 44 }}><Heart size={20} /></div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>Merci d’utiliser BCenter</div>
          <div className="faint">Version {version}</div>
        </div>
      </div>
      <div className="grid three" style={{ gap: 8 }}>
        <button className="btn outline-accent" onClick={() => go('infrastructure')}><Network size={14} /> Infrastructure</button>
        <button className="btn" onClick={() => go('updates')}><Wrench size={14} /> Mises à jour</button>
        <button className="btn" onClick={() => go('settings')}><KeyRound size={14} /> Réglages</button>
      </div>
      <p className="faint" style={{ margin: '14px 0 16px' }}>
        La surveillance tourne en arrière-plan : fermer la fenêtre laisse BCenter actif dans la zone de notification.
      </p>
      <hr style={{ border: 0, borderTop: '1px solid var(--border-soft)', margin: '0 0 14px' }} />
      <div style={{ fontWeight: 600, marginBottom: 10 }}>Quoi de neuf dans la {version}</div>
      <div className="card" style={{ background: 'var(--panel-2)', padding: '14px 16px' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}><BookOpen size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Nouveautés</div>
        <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
          <li>Nouvelle interface (React) et moteur Electron.</li>
          <li>Snapshot Proxmox automatique avant chaque mise à jour, restaurable en un clic.</li>
          <li>Console intégrée : journal de l’application et des tâches en direct.</li>
          <li>Vos sauvegardes NAS / Proxmox Backup Server restent gérées par Proxmox.</li>
        </ul>
      </div>
    </Modal>
  )
}
