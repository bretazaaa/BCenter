import { Download, KeyRound, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { IMPORT_SOURCES, type ImportCandidate, type ImportProbe, type ImportSourceStatus } from '@shared/types'
import { CredentialModal } from '../components/modals'
import { Badge, Callout, Check, Modal, Progress } from '../components/ui'
import { api } from '../lib/api'
import { useApp } from '../store'

type Step = 'loading' | 'select' | 'probing' | 'review' | 'importing'

/**
 * Import des connexions SSH d'autres gestionnaires (XPipe, OpenSSH, PuTTY, WinSCP, MobaXterm).
 * Les mots de passe ne sont jamais importés ; chaque clé d'hôte est lue puis approuvée avant l'ajout.
 */
export function ImportModal({ onClose }: { onClose: () => void }) {
  const credentials = useApp((s) => s.credentials)
  const [step, setStep] = useState<Step>('loading')
  const [sources, setSources] = useState<ImportSourceStatus[]>([])
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [creds, setCreds] = useState<Record<string, string>>({})
  const [probes, setProbes] = useState<Record<string, ImportProbe>>({})
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addCredential, setAddCredential] = useState(false)
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const [sharedPassword, setSharedPassword] = useState('')
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([])

  // Par défaut : identifiants du même utilisateur, sinon création depuis la clé détectée, sinon saisie du mot de passe.
  const defaultCredential = (c: ImportCandidate) =>
    credentials.find((x) => c.username && x.username === c.username && (!c.keyPath || x.privateKeyPath === c.keyPath))?.id
    ?? (c.keyPath && c.username ? 'auto-key' : c.username ? 'password' : credentials[0]?.id ?? '')
  const passwordOf = (id: string) => passwords[id] || sharedPassword

  useEffect(() => {
    api.discoverImports().then(
      (r) => {
        setSources(r.sources)
        setCandidates(r.candidates)
        setSelected(new Set(r.candidates.filter((c) => !c.existingTargetId).map((c) => c.id)))
        setStep('select')
      },
      (e: Error) => {
        setError(e.message)
        setStep('select')
      },
    )
  }, [])

  // Identifiants proposés par défaut (et après l'ajout de nouveaux identifiants).
  useEffect(() => {
    setCreds((prev) => Object.fromEntries(candidates.map((c) => [c.id, prev[c.id] || defaultCredential(c)])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, credentials])

  const chosen = candidates.filter((c) => selected.has(c.id))
  const reviewed = chosen.filter((c) => probes[c.id]?.hostKey)
  const needsApproval = reviewed.some((c) => probes[c.id].knownHosts !== 'match')
  const missingCredential = chosen.some((c) => !creds[c.id] || (creds[c.id] === 'password' && !passwordOf(c.id)))

  const toggle = (id: string, on: boolean) => setSelected((s) => {
    const next = new Set(s)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })

  const probe = async () => {
    setStep('probing')
    setError(null)
    try {
      const results = await api.probeImports(chosen)
      setProbes(Object.fromEntries(results.map((p) => [p.id, p])))
      // Machines injoignables ou dont la clé diffère de known_hosts : décochées par prudence.
      setSelected((s) => new Set([...s].filter((id) => results.find((p) => p.id === id)?.hostKey && results.find((p) => p.id === id)?.knownHosts !== 'mismatch')))
      setApproved(false)
      setStep('review')
    } catch (e) {
      setError((e as Error).message)
      setStep('select')
    }
  }

  const run = async () => {
    setStep('importing')
    setFailures([])
    try {
      const result = await api.importConnections(reviewed.map((c) => ({
        candidate: c, hostKey: probes[c.id].hostKey!, credentialId: creds[c.id],
        password: creds[c.id] === 'password' ? passwordOf(c.id) : undefined,
      })))
      await useApp.getState().reloadLists()
      if (result.added) {
        const linked = result.linkedToProxmox ? ` dont ${result.linkedToProxmox} liée(s) à un invité Proxmox` : ''
        useApp.getState().toast('success', `${result.added} connexion(s) vérifiée(s) et importée(s)${linked}.`)
      }
      if (result.errors.length === 0) return onClose()
      // Échecs (mot de passe refusé…) : la fenêtre reste ouverte pour corriger et réessayer.
      const failed = new Set(result.errors.map((e) => e.name))
      setCandidates((list) => list.filter((c) => !reviewed.includes(c) || failed.has(c.name)))
      setFailures(result.errors)
      setStep('select')
    } catch (e) {
      setError((e as Error).message)
      setStep('review')
    }
  }

  const found = sources.filter((s) => s.found)
  const credentialOptions = useMemo(() => credentials.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.username})</option>), [credentials])

  return (
    <Modal
      title="Importer des connexions"
      width={980}
      onClose={onClose}
      footer={
        <>
          <span className="error">{error ?? (missingCredential && step !== 'loading' ? 'Choisissez des identifiants pour chaque connexion.' : '')}</span>
          <button className="btn" onClick={onClose}>Annuler</button>
          {step === 'review' || step === 'importing' ? (
            <button className="btn primary" disabled={step === 'importing' || reviewed.length === 0 || missingCredential || (needsApproval && !approved)} onClick={() => void run()}>
              <Download size={14} /> Vérifier et importer {reviewed.length} connexion(s)
            </button>
          ) : (
            <button className="btn primary" disabled={step !== 'select' || chosen.length === 0 || missingCredential} onClick={() => void probe()}>
              {step === 'probing' ? <RefreshCw size={14} className="spin" /> : <ShieldCheck size={14} />} Vérifier les clés d’hôte
            </button>
          )}
        </>
      }
    >
      {step === 'loading' ? <div style={{ padding: 30 }}><Progress indeterminate /><div className="faint" style={{ marginTop: 10, textAlign: 'center' }}>Recherche des gestionnaires de connexions…</div></div> : (
        <>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {sources.map((s) => (
              <span key={s.source} className="chip" title={s.error ?? s.location}>
                <span className={`dot ${s.error ? 'bad' : s.found ? 'ok' : ''}`} />
                {IMPORT_SOURCES[s.source]} — {s.error ? 'illisible' : s.found ? `${s.count} connexion(s)` : 'non trouvé'}
              </span>
            ))}
          </div>

          {found.length === 0 || candidates.length === 0 ? (
            <Callout>Aucune connexion SSH trouvée. BCenter lit XPipe (~/.xpipe), OpenSSH (~/.ssh/config), PuTTY et WinSCP (registre Windows) et MobaXterm (MobaXterm.ini).</Callout>
          ) : (
            <>
              <Callout>
                Les mots de passe restent dans le coffre chiffré de chaque logiciel : saisissez-les ici (une seule fois pour toutes les machines qui partagent le même),
                ou choisissez des identifiants BCenter existants. Chaque connexion est testée avant d’être ajoutée.{' '}
                <button className="btn ghost sm" style={{ height: 22 }} onClick={() => setAddCredential(true)}><KeyRound size={12} /> Ajouter des identifiants</button>
              </Callout>
              {step === 'select' && (
                <div className="row" style={{ alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 12.5 }}>Pour toutes les connexions sélectionnées :</span>
                  <select className="select" style={{ width: 280, height: 30 }} value="" onChange={(e) => {
                    const id = e.target.value
                    if (id) setCreds((x) => ({ ...x, ...Object.fromEntries(chosen.map((c) => [c.id, id])) }))
                  }}>
                    <option value="">— Appliquer à toutes —</option>
                    <option value="password">Mot de passe (saisi une seule fois)</option>
                    {credentialOptions}
                  </select>
                  {chosen.some((c) => creds[c.id] === 'password') && (
                    <input className="input" type="password" style={{ width: 240, height: 30 }} placeholder="Mot de passe commun"
                      value={sharedPassword} onChange={(e) => setSharedPassword(e.target.value)} />
                  )}
                </div>
              )}
              <div style={{ maxHeight: 420, overflow: 'auto', marginTop: 12, border: '1px solid var(--border-soft)', borderRadius: 10 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="w-check"><Check checked={chosen.length > 0 && chosen.length === candidates.filter((c) => !c.existingTargetId).length} onChange={(v) => setSelected(v ? new Set(candidates.filter((c) => !c.existingTargetId).map((c) => c.id)) : new Set())} /></th>
                      <th>Nom</th><th>Adresse</th><th>Utilisateur</th><th>Source</th><th>Dossier</th><th style={{ width: 230 }}>Identifiants</th>{step !== 'select' && <th>Clé d’hôte</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => {
                      const p = probes[c.id]
                      return (
                        <tr key={c.id} style={{ opacity: c.existingTargetId ? 0.5 : 1 }}>
                          <td className="w-check"><Check checked={selected.has(c.id)} disabled={!!c.existingTargetId || step === 'probing' || (step !== 'select' && !p?.hostKey)} onChange={(v) => toggle(c.id, v)} /></td>
                          <td><b>{c.name}</b>{c.existingTargetId && <span className="faint" style={{ marginLeft: 6, fontSize: 12 }}>déjà présente</span>}</td>
                          <td className="mono faint">{c.host}{c.port !== 22 ? `:${c.port}` : ''}</td>
                          <td className="muted">{c.username ?? '—'}</td>
                          <td className="muted">{IMPORT_SOURCES[c.source].split(' (')[0]}</td>
                          <td className="muted">{c.group ?? '—'}</td>
                          <td>
                            <select className="select" style={{ height: 28 }} value={creds[c.id] ?? ''} disabled={!!c.existingTargetId || step !== 'select'}
                              onChange={(e) => setCreds((x) => ({ ...x, [c.id]: e.target.value }))}>
                              <option value="">— Choisir —</option>
                              {c.keyPath && c.username && <option value="auto-key">Créer depuis la clé ({c.keyPath.split(/[\\/]/).pop()})</option>}
                              {c.username && <option value="password">Mot de passe de {c.username}…</option>}
                              {credentialOptions}
                            </select>
                            {creds[c.id] === 'password' && !c.existingTargetId && (
                              <input className="input" type="password" style={{ height: 28, marginTop: 4 }} disabled={step !== 'select'}
                                placeholder={sharedPassword ? 'Mot de passe commun' : `Mot de passe de ${c.username}`}
                                value={passwords[c.id] ?? ''} onChange={(e) => setPasswords((x) => ({ ...x, [c.id]: e.target.value }))} />
                            )}
                            {(() => {
                              const user = credentials.find((x) => x.id === creds[c.id])?.username
                              return user && c.username && user !== c.username && !c.existingTargetId
                                ? <div style={{ color: 'var(--warning)', fontSize: 11.5, marginTop: 3 }}>Connexion en tant que {user}, pas {c.username}</div>
                                : null
                            })()}
                          </td>
                          {step !== 'select' && (
                            <td>
                              {!p ? <span className="faint">—</span>
                                : p.error ? <span title={p.error}><Badge kind="danger">Injoignable</Badge></span>
                                : p.knownHosts === 'match' ? <span title={`SHA256:${p.hostKey!.fingerprint}`}><Badge kind="success">Connue</Badge></span>
                                : p.knownHosts === 'mismatch' ? <span title={`SHA256:${p.hostKey!.fingerprint}`}><Badge kind="danger">Différente de known_hosts</Badge></span>
                                : <span className="mono faint" style={{ fontSize: 11 }} title={p.hostKey!.algorithm}><Badge kind="warning">Nouvelle</Badge> {p.hostKey!.fingerprint.slice(0, 12)}…</span>}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {failures.length > 0 && (
                <div className="callout danger" style={{ marginTop: 12, display: 'block' }}>
                  <b>Non importées après vérification :</b>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                    {failures.map((f) => <li key={f.name}><b>{f.name}</b> — {f.message}</li>)}
                  </ul>
                  <div className="faint" style={{ marginTop: 6, fontSize: 12 }}>Corrigez le mot de passe ou les identifiants puis relancez « Vérifier les clés d’hôte ».</div>
                </div>
              )}
              {step === 'review' && needsApproval && (
                <div className="callout warning" style={{ marginTop: 12 }}>
                  <ShieldAlert size={16} />
                  <Check checked={approved} onChange={setApproved}>
                    Certaines clés d’hôte ne figurent pas dans ~/.ssh/known_hosts (« Nouvelle »). J’ai vérifié leurs empreintes (survol pour la valeur complète) et je les approuve.
                  </Check>
                </div>
              )}
              {step === 'review' && !needsApproval && reviewed.length > 0 && (
                <div className="faint" style={{ marginTop: 10, fontSize: 12 }}>Toutes les clés d’hôte correspondent à ~/.ssh/known_hosts.</div>
              )}
            </>
          )}
        </>
      )}
      {addCredential && <CredentialModal onClose={() => setAddCredential(false)} />}
    </Modal>
  )
}
