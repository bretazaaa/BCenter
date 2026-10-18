import { ArrowLeft, Bell, Check as CheckIcon, Network, Settings2, ShieldCheck, TerminalSquare, Wrench, Activity } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/types'
import { ServerFields, ServerTest, SshFields, useServerForm, useSshForm } from '../components/forms'
import { Field, Logo, SettingRow, Switch } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../store'
import './wizard.css'

const STEPS = [
  ['Bienvenue', 'Découvrir BCenter'],
  ['Langue et préférences', 'Langue, démarrage, notifications'],
  ['Configuration', 'Surveillance et maintenance'],
  ['Serveur Proxmox', 'Adresse et jeton API'],
  ['Test de connexion', 'Certificat et API'],
  ['Accès SSH', 'Mises à jour des machines'],
  ['Résumé', 'Vérifier et terminer'],
] as const

/** Assistant de première configuration (affiché tant que la configuration n'est pas terminée). */
export function Wizard() {
  const initial = useApp((s) => s.settings) ?? DEFAULT_SETTINGS
  const [step, setStep] = useState(0)
  const [settings, setSettings] = useState<AppSettings>(initial)
  const [serverSkipped, setServerSkipped] = useState(false)
  const [sshSkipped, setSshSkipped] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const server = useServerForm()
  const ssh = useSshForm()
  const patch = (p: Partial<AppSettings>) => setSettings((s) => ({ ...s, ...p }))

  const canNext =
    !finishing && (step === 3 ? server.valid : step === 4 ? server.verified : step === 5 ? ssh.valid : true)
  const canSkip = step >= 3 && step <= 5

  const next = async () => {
    setError(null)
    if (step === 3) {
      setServerSkipped(false)
      setStep(4)
      void server.test()
      return
    }
    if (step === 5) setSshSkipped(false)
    if (step === 6) return finish()
    setStep(step + 1)
  }

  const skip = () => {
    if (step === 3 || step === 4) {
      setServerSkipped(true)
      setStep(5)
    } else {
      setSshSkipped(true)
      setStep(6)
    }
  }

  const back = () => setStep(step === 5 && serverSkipped ? 3 : step - 1)

  const finish = async () => {
    setFinishing(true)
    try {
      const credential = !sshSkipped && ssh.valid ? ssh.draft() : undefined
      await api.completeSetup({
        settings: { ...settings, setupCompleted: true },
        server: !serverSkipped && server.verified ? server.draft() : undefined,
        credential,
        testedTarget:
          credential && ssh.tested && ssh.addTested && ssh.hostKey
            ? { name: ssh.system?.hostname ?? ssh.testHost, host: ssh.testHost, port: Number(ssh.testPort), credentialId: '', hostKey: ssh.hostKey, guest: null }
            : undefined,
      })
      useApp.setState({ settings: await api.getSettings() })
      await useApp.getState().reloadLists()
      localStorage.removeItem('bcenter.welcomeSeen')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setFinishing(false)
    }
  }

  const skipped = (i: number) => (serverSkipped && (i === 3 || i === 4)) || (sshSkipped && i === 5)

  return (
    <div className="wizard">
      <aside className="wz-rail">
        <div className="wz-brand"><Logo size={38} /><div><b>BCenter</b><span>Première configuration</span></div></div>
        <ol>
          {STEPS.map(([title, desc], i) => (
            <li key={title} className={i === step ? 'current' : i < step && !skipped(i) ? 'done' : ''}>
              <span className="num">{i < step && !skipped(i) ? <CheckIcon size={13} /> : i + 1}</span>
              <div><b>{title}</b><span>{skipped(i) ? 'Ignoré pour l’instant' : desc}</span></div>
            </li>
          ))}
        </ol>
        <p className="faint">Les secrets sont chiffrés avec Windows DPAPI et liés à votre compte Windows.</p>
      </aside>

      <section className="wz-main">
        <div className="wz-body" key={step}>
          {step === 0 && <Welcome />}
          {step === 1 && (
            <StepHead title="Langue et préférences" lead="Choisissez la langue et le comportement de BCenter sur votre poste.">
              <Field label="Langue" hint="Détermine aussi le format des dates et des nombres.">
                <select className="select" style={{ width: 360 }} value={settings.language} onChange={(e) => patch({ language: e.target.value })}>
                  <option value="fr-FR">Français</option>
                  <option value="en-US">English (interface en cours de traduction)</option>
                </select>
              </Field>
              <div className="card">
                <SettingRow title="Lancer BCenter au démarrage de Windows" description="Surveillance active dès l’ouverture de votre session.">
                  <Switch checked={settings.startWithWindows} onChange={(v) => patch({ startWithWindows: v })} />
                </SettingRow>
                <SettingRow title="Démarrer réduit dans la zone de notification" description="Lors du lancement automatique uniquement.">
                  <Switch checked={settings.startMinimized} disabled={!settings.startWithWindows} onChange={(v) => patch({ startMinimized: v })} />
                </SettingRow>
                <SettingRow title="Continuer en arrière-plan à la fermeture de la fenêtre" description="La surveillance et les tâches en cours se poursuivent depuis la zone de notification.">
                  <Switch checked={settings.minimizeToTray} onChange={(v) => patch({ minimizeToTray: v })} />
                </SettingRow>
                <SettingRow title="Notifications Windows" description="Alertes critiques et fin des tâches de maintenance.">
                  <Switch checked={settings.notifications} onChange={(v) => patch({ notifications: v })} />
                </SettingRow>
              </div>
            </StepHead>
          )}
          {step === 2 && (
            <StepHead title="Configuration de l’application" lead="Réglez la surveillance et les règles de maintenance. Tout reste modifiable dans Réglages.">
              <div className="row">
                <div className="grow">
                  <Field label="Intervalle d’actualisation" hint="Fréquence d’interrogation de l’API Proxmox.">
                    <select className="select" value={settings.refreshInterval} onChange={(e) => patch({ refreshInterval: Number(e.target.value) })}>
                      {[5, 10, 15, 30, 60, 120].map((v) => <option key={v} value={v}>{v} secondes</option>)}
                    </select>
                  </Field>
                </div>
                <div className="grow">
                  <Field label="Tâches de maintenance simultanées" hint="Nombre de machines mises à jour en parallèle.">
                    <select className="select" value={settings.maxParallelJobs} onChange={(e) => patch({ maxParallelJobs: Number(e.target.value) })}>
                      {[1, 2, 3, 4].map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </Field>
                </div>
              </div>
              <div className="card" style={{ marginBottom: 16 }}>
                <SettingRow title="Snapshot Proxmox avant chaque mise à jour" description="Recommandé. Retour arrière en un clic ; la mise à jour est annulée si le snapshot échoue.">
                  <Switch checked={settings.snapshotBeforeUpdate} onChange={(v) => patch({ snapshotBeforeUpdate: v })} />
                </SettingRow>
                <SettingRow title="Conservation des snapshots BCenter" description="Supprimés automatiquement ensuite. Vos sauvegardes NAS / PBS et vos snapshots manuels ne sont jamais touchés.">
                  <select className="select" style={{ width: 140 }} value={settings.snapshotRetentionDays} disabled={!settings.snapshotBeforeUpdate} onChange={(e) => patch({ snapshotRetentionDays: Number(e.target.value) })}>
                    {[1, 3, 7, 14, 30].map((v) => <option key={v} value={v}>{v} jour{v > 1 ? 's' : ''}</option>)}
                  </select>
                </SettingRow>
                <SettingRow title="Vérifier les nouvelles versions de BCenter" description="Depuis les Releases GitHub du projet, au démarrage puis toutes les 6 h. Installation sur votre accord.">
                  <Switch checked={settings.checkForUpdates} onChange={(v) => patch({ checkForUpdates: v })} />
                </SettingRow>
              </div>
            </StepHead>
          )}
          {step === 3 && (
            <StepHead title="Ajouter un serveur Proxmox" lead="BCenter se connecte à l’API Proxmox VE avec un jeton API dédié. Vous pourrez ajouter d’autres serveurs plus tard.">
              <ServerFields form={server} />
            </StepHead>
          )}
          {step === 4 && (
            <StepHead title="Test de connexion" lead="BCenter vérifie le certificat TLS du serveur, puis l’authentification du jeton API.">
              <ServerTest form={server} />
            </StepHead>
          )}
          {step === 5 && (
            <StepHead title="Accès SSH pour les mises à jour" lead="Les mises à jour des VM et conteneurs sont exécutées par BCenter via SSH. Ces identifiants serviront par défaut pour vos machines.">
              <SshFields form={ssh} />
            </StepHead>
          )}
          {step === 6 && (
            <StepHead title="Tout est prêt" lead="Vérifiez la configuration puis terminez. Vous pourrez tout modifier dans Réglages.">
              <Summary icon={<Settings2 size={17} />} title="Préférences">
                {settings.language === 'fr-FR' ? 'Français' : 'English'} · {settings.startWithWindows ? 'démarrage avec Windows' : 'démarrage manuel'} · actualisation toutes les {settings.refreshInterval} s
              </Summary>
              <Summary icon={<Network size={17} />} title="Serveur Proxmox">
                {serverSkipped || !server.verified ? 'Aucun serveur — vous pourrez l’ajouter plus tard.' : `${server.name} (${server.host}:${server.port}) — ${server.version}`}
              </Summary>
              <Summary icon={<TerminalSquare size={17} />} title="Accès SSH">
                {sshSkipped ? 'Non configuré — à faire depuis le centre de mises à jour.' : `${ssh.username} (${ssh.authMethod === 'key' ? 'clé privée' : 'mot de passe'})${ssh.tested && ssh.addTested ? ` — machine ${ssh.testHost} ajoutée` : ''}`}
              </Summary>
              <Summary icon={<ShieldCheck size={17} />} title="Sécurité">
                Secrets chiffrés par Windows DPAPI · certificats TLS et clés d’hôte SSH vérifiés · snapshot avant mise à jour {settings.snapshotBeforeUpdate ? 'activé' : 'désactivé'}
              </Summary>
            </StepHead>
          )}
        </div>

        <footer className="wz-foot">
          <button className="btn" onClick={back} disabled={step === 0 || finishing}><ArrowLeft size={14} /> Retour</button>
          <span className="error">{error}</span>
          {canSkip && <button className="btn ghost" onClick={skip}>Ignorer pour l’instant</button>}
          <button className="btn primary" style={{ minWidth: 150 }} onClick={() => void next()} disabled={!canNext}>
            {step === 0 ? 'Commencer' : step === 6 ? (finishing ? 'Finalisation…' : 'Terminer la configuration') : 'Continuer'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function StepHead({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="lead">{lead}</p>
      {children}
    </>
  )
}

function Summary({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="card wz-summary">
      <div className="icon-tile">{icon}</div>
      <div><b>{title}</b><div className="muted">{children}</div></div>
    </div>
  )
}

function Welcome() {
  const features: [ReactNode, string, string][] = [
    [<Activity size={18} />, 'Supervision en temps réel', 'Nœuds, VM, conteneurs, stockages et métriques historiques.'],
    [<Wrench size={18} />, 'Mises à jour centralisées', 'Analyse et application des mises à jour via SSH, avec snapshot préalable.'],
    [<Bell size={18} />, 'Alertes et notifications', 'Notifications Windows, même lorsque BCenter est réduit.'],
    [<ShieldCheck size={18} />, 'Sécurité locale', 'Secrets chiffrés par Windows, certificats et clés SSH vérifiés.'],
  ]
  return (
    <>
      <div style={{ marginBottom: 18 }}><Logo size={120} variant="full" /></div>
      <h1 style={{ fontSize: 30 }}>Bienvenue sur BCenter</h1>
      <p className="lead">BCenter centralise la supervision et la maintenance de votre infrastructure Proxmox VE, directement depuis votre PC Windows. Quelques minutes suffisent pour le configurer.</p>
      <div className="grid halves">
        {features.map(([icon, title, text]) => (
          <div className="card" key={title}>
            <div className="icon-tile">{icon}</div>
            <div style={{ fontWeight: 600, margin: '12px 0 4px' }}>{title}</div>
            <div className="muted">{text}</div>
          </div>
        ))}
      </div>
    </>
  )
}
