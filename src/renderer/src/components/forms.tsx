import { FolderOpen, KeyRound, RefreshCw, ShieldCheck, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import type { CredentialDraft, ServerDraft } from '@shared/api'
import type { CertificateInfo, HostKeyInfo, RemoteSystem, ServerProfile } from '@shared/types'
import { api, isWeb } from '../lib/api'
import { formatFingerprint } from '../lib/format'
import { Badge, Callout, Check, Field, Progress, Segmented } from './ui'

type TestState = 'idle' | 'testing' | 'approval' | 'success' | 'failed'

// ------------------------------------------------------------------ Serveur Proxmox

export function useServerForm(initial?: ServerProfile) {
  const [name, setName] = useState(initial?.name ?? 'Proxmox')
  const [host, setHostRaw] = useState(initial?.host ?? '')
  const [port, setPortRaw] = useState(String(initial?.port ?? 8006))
  const [tokenId, setTokenIdRaw] = useState(initial?.tokenId ?? 'root@pam!bcenter')
  const [tokenSecret, setSecretRaw] = useState('')
  const [certificate, setCertificate] = useState<CertificateInfo | null>(null)
  const [approved, setApproved] = useState(false)
  const [state, setState] = useState<TestState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [version, setVersion] = useState<string | null>(null)

  const reset = (certToo: boolean) => {
    if (state !== 'testing') {
      setState('idle')
      setMessage(null)
    }
    if (certToo) {
      setCertificate(null)
      setApproved(false)
    }
  }
  const setHost = (v: string) => { setHostRaw(v); reset(true) }
  const setPort = (v: string) => { setPortRaw(v); reset(true) }
  const setTokenId = (v: string) => { setTokenIdRaw(v); reset(false) }
  const setTokenSecret = (v: string) => { setSecretRaw(v); reset(false) }

  const validate = (): string | null => {
    if (!name.trim()) return 'Indiquez un nom pour ce serveur.'
    if (!/^[a-z0-9.\-:[\]]+$/i.test(host.trim())) return 'Adresse du serveur invalide.'
    const p = Number(port)
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port invalide.'
    if (!tokenId.includes('@') || !tokenId.includes('!')) return "L'identifiant du jeton doit être au format utilisateur@realm!nom."
    if (!tokenSecret && !initial) return 'Saisissez le secret du jeton API.'
    return null
  }

  const draft = (cert = certificate, trust = approved): ServerDraft => ({
    id: initial?.id,
    name: name.trim(),
    host: host.trim(),
    port: Number(port),
    tokenId: tokenId.trim(),
    tokenSecret: tokenSecret.trim(),
    pinnedFingerprint: cert && !cert.trustedBySystem && trust ? cert.fingerprint : null,
  })

  const test = async (approve = approved) => {
    const error = validate()
    if (error) {
      setState('failed')
      setMessage(error)
      return
    }
    setState('testing')
    setVersion(null)
    setMessage('Vérification du certificat TLS…')
    try {
      const cert = await api.probeCertificate(host.trim(), Number(port))
      const trust = approve && certificate?.fingerprint === cert.fingerprint
      setCertificate(cert)
      setApproved(trust)
      if (!cert.trustedBySystem && !trust) {
        setState('approval')
        setMessage("Ce certificat n'est pas reconnu par Windows (certificat auto-signé Proxmox). Comparez l'empreinte avec celle affichée dans Proxmox (Nœud › Système › Certificats) puis approuvez-la.")
        return
      }
      setMessage('Authentification auprès de l’API…')
      const result = await api.testServer(draft(cert, trust))
      setVersion(result.version)
      setState('success')
      setMessage(`Connexion réussie — ${result.version}.`)
    } catch (e) {
      setState('failed')
      setMessage((e as Error).message)
    }
  }

  const approve = () => {
    setApproved(true)
    void test(true)
  }

  return {
    name, setName, host, setHost, port, setPort, tokenId, setTokenId, tokenSecret, setTokenSecret,
    certificate, approved, state, message, version, editing: !!initial,
    valid: validate() === null, verified: state === 'success', validate, draft, test, approve,
  }
}

export type ServerForm = ReturnType<typeof useServerForm>

export function ServerFields({ form }: { form: ServerForm }) {
  return (
    <>
      <Field label="Nom affiché" hint="Nom libre pour identifier ce serveur ou ce cluster dans BCenter.">
        <input className="input" value={form.name} onChange={(e) => form.setName(e.target.value)} placeholder="Cluster principal" />
      </Field>
      <div className="row">
        <div className="grow">
          <Field label="Adresse du serveur" hint="Nom DNS ou adresse IP d'un nœud Proxmox VE.">
            <input className="input" value={form.host} onChange={(e) => form.setHost(e.target.value)} placeholder="pve.mondomaine.lan ou 192.168.1.10" autoFocus />
          </Field>
        </div>
        <div style={{ width: 110 }}>
          <Field label="Port"><input className="input" value={form.port} onChange={(e) => form.setPort(e.target.value)} /></Field>
        </div>
      </div>
      <Field label="Identifiant du jeton API" hint="Format utilisateur@realm!nom — Proxmox : Datacenter › Permissions › API Tokens.">
        <input className="input mono" value={form.tokenId} onChange={(e) => form.setTokenId(e.target.value)} placeholder="bcenter@pve!bcenter" />
      </Field>
      <Field
        label="Secret du jeton API"
        hint={form.editing ? 'Laissez vide pour conserver le secret actuel.' : "Chiffré avec Windows DPAPI : il n'est jamais écrit en clair ni journalisé."}
      >
        <input className="input mono" type="password" value={form.tokenSecret} onChange={(e) => form.setTokenSecret(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      </Field>
      <Callout>
        Privilèges conseillés pour le jeton : <b>Sys.Audit</b>, <b>VM.Audit</b>, <b>Datastore.Audit</b> (lecture), <b>VM.Snapshot</b> et{' '}
        <b>VM.Snapshot.Rollback</b> (snapshots avant mise à jour), <b>VM.PowerMgmt</b> (actions) et <b>VM.Monitor</b> (adresses IP via l’agent QEMU).
      </Callout>
    </>
  )
}

export function ServerTest({ form }: { form: ServerForm }) {
  const cert = form.certificate
  return (
    <div className="stack">
      <div className="card" style={{ background: 'var(--panel-2)' }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <div className="icon-tile">
            {form.state === 'testing' ? <RefreshCw size={17} className="spin" /> : <ShieldCheck size={17} />}
          </div>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>Connexion à {form.host || '…'}</div>
            <div className="muted" style={{ marginTop: 3, color: form.state === 'failed' ? 'var(--danger)' : form.state === 'success' ? 'var(--success)' : undefined }}>
              {form.message ?? 'Lancez le test pour vérifier le certificat et le jeton API.'}
            </div>
          </div>
          <button className="btn" onClick={() => void form.test()} disabled={form.state === 'testing'}>
            <RefreshCw size={14} /> Tester
          </button>
        </div>
        {form.state === 'testing' && <div style={{ marginTop: 12 }}><Progress indeterminate /></div>}
      </div>

      {cert && (
        <div className="card">
          <div className="card-head">
            <div><h3>Certificat TLS</h3><p>Présenté par le serveur</p></div>
            <div className="actions">
              {cert.trustedBySystem ? <Badge kind="success">Approuvé par Windows</Badge> : form.approved ? <Badge kind="success">Empreinte approuvée</Badge> : <Badge kind="warning">Non reconnu par Windows</Badge>}
            </div>
          </div>
          <dl className="kv">
            <dt>Sujet</dt><dd>{cert.subject}</dd>
            <dt>Émetteur</dt><dd>{cert.issuer}</dd>
            <dt>Validité</dt><dd>du {new Date(cert.validFrom).toLocaleDateString('fr-FR')} au {new Date(cert.validTo).toLocaleDateString('fr-FR')}</dd>
            <dt>SHA-256</dt><dd className="mono">{formatFingerprint(cert.fingerprint)}</dd>
          </dl>
          {form.state === 'approval' && (
            <div className="callout warning" style={{ marginTop: 14, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                N’approuvez cette empreinte que si elle est identique à celle affichée dans Proxmox. BCenter refusera ensuite tout autre certificat pour ce serveur.
              </div>
              <button className="btn primary" onClick={form.approve}><ShieldCheck size={14} /> Approuver l’empreinte</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ Identifiants SSH

export function useSshForm() {
  const [name, setName] = useState('Identifiants par défaut')
  const [username, setUsername] = useState('root')
  const [authMethod, setAuthMethod] = useState<'key' | 'password'>('key')
  const [privateKeyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [password, setPassword] = useState('')
  const [useSudo, setUseSudo] = useState(true)
  const [testHost, setTestHostRaw] = useState('')
  const [testPort, setTestPortRaw] = useState('22')
  const [hostKey, setHostKey] = useState<HostKeyInfo | null>(null)
  const [trusted, setTrusted] = useState(false)
  const [state, setState] = useState<TestState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [system, setSystem] = useState<RemoteSystem | null>(null)
  const [addTested, setAddTested] = useState(true)

  const resetKey = () => { setHostKey(null); setTrusted(false); setState('idle'); setMessage(null) }
  const setTestHost = (v: string) => { setTestHostRaw(v); resetKey() }
  const setTestPort = (v: string) => { setTestPortRaw(v); resetKey() }

  const validate = (): string | null => {
    if (!name.trim()) return 'Indiquez un nom pour ces identifiants.'
    if (!username.trim()) return "Indiquez le nom d'utilisateur SSH."
    if (authMethod === 'key' && !privateKeyPath.trim()) return 'Sélectionnez le fichier de clé privée.'
    if (authMethod === 'password' && !password) return 'Saisissez le mot de passe SSH.'
    return null
  }

  const draft = (): CredentialDraft => ({
    name: name.trim(), username: username.trim(), authMethod,
    privateKeyPath: authMethod === 'key' ? privateKeyPath.trim() : null, useSudo,
    password: authMethod === 'password' ? password : undefined,
    passphrase: authMethod === 'key' && passphrase ? passphrase : undefined,
  })

  const test = async (trust = trusted) => {
    const error = validate()
    if (error) { setState('failed'); setMessage(error); return }
    if (!testHost.trim()) { setState('failed'); setMessage("Indiquez l'adresse d'une machine de test."); return }
    setState('testing')
    setSystem(null)
    try {
      let key = hostKey
      if (!key) {
        setMessage('Lecture de la clé d’hôte…')
        key = await api.probeHostKey(testHost.trim(), Number(testPort))
        setHostKey(key)
      }
      if (!trust) {
        setState('approval')
        setMessage('Vérifiez que cette empreinte correspond à la machine (ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub) avant de l’approuver.')
        return
      }
      setMessage('Connexion SSH…')
      const sys = await api.testSsh(draft(), testHost.trim(), Number(testPort), key)
      setSystem(sys)
      setState('success')
      setMessage(`Connecté à ${sys.hostname} — ${sys.osName ?? ''} ${sys.osVersion ?? ''} (${sys.packageManager})${sys.isRoot || !useSudo ? '.' : '. Les commandes seront exécutées avec sudo -n.'}`)
    } catch (e) {
      setState('failed')
      setMessage((e as Error).message)
    }
  }

  const approve = () => { setTrusted(true); void test(true) }

  return {
    name, setName, username, setUsername, authMethod, setAuthMethod, privateKeyPath, setKeyPath, passphrase, setPassphrase,
    password, setPassword, useSudo, setUseSudo, testHost, setTestHost, testPort, setTestPort, hostKey, trusted, state, message,
    system, addTested, setAddTested, valid: validate() === null, tested: state === 'success', validate, draft, test, approve,
  }
}

export type SshForm = ReturnType<typeof useSshForm>

export function SshFields({ form, withTest = true }: { form: SshForm; withTest?: boolean }) {
  return (
    <>
      <div className="row">
        <div className="grow"><Field label="Nom des identifiants"><input className="input" value={form.name} onChange={(e) => form.setName(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Utilisateur SSH"><input className="input" value={form.username} onChange={(e) => form.setUsername(e.target.value)} placeholder="root" /></Field></div>
      </div>
      <Field label="Méthode d’authentification">
        <div><Segmented value={form.authMethod} onChange={form.setAuthMethod} options={[['key', 'Clé privée (recommandé)'], ['password', 'Mot de passe']]} /></div>
      </Field>
      {form.authMethod === 'key' ? (
        <>
          <Field label="Fichier de clé privée" hint={isWeb() ? "Chemin de la clé sur le serveur BCenter : montez votre dossier .ssh dans le conteneur, en lecture seule (voir docker-compose.yml)." : "OpenSSH ou PEM. Seul le chemin est enregistré ; la clé reste dans votre dossier."}>
            <div className="row">
              <input className="input mono grow" value={form.privateKeyPath} onChange={(e) => form.setKeyPath(e.target.value)} placeholder="C:\Users\…\.ssh\id_ed25519" />
              {!isWeb() && <button className="btn" onClick={async () => { const p = await api.pickPrivateKey(); if (p) form.setKeyPath(p) }}><FolderOpen size={14} /> Parcourir…</button>}
            </div>
          </Field>
          <Field label="Phrase de passe (facultative)" hint="Chiffrée avec Windows DPAPI.">
            <input className="input" type="password" value={form.passphrase} onChange={(e) => form.setPassphrase(e.target.value)} />
          </Field>
        </>
      ) : (
        <Field label="Mot de passe" hint="Chiffré avec Windows DPAPI. Préférez une clé privée lorsque c’est possible.">
          <input className="input" type="password" value={form.password} onChange={(e) => form.setPassword(e.target.value)} />
        </Field>
      )}
      <div style={{ marginBottom: withTest ? 18 : 0 }}>
        <Check checked={form.useSudo} onChange={form.setUseSudo}>Utiliser sudo (sans mot de passe) lorsque l’utilisateur n’est pas root</Check>
      </div>
      {withTest && <SshTest form={form} />}
    </>
  )
}

function SshTest({ form }: { form: SshForm }) {
  return (
    <div className="card">
      <div className="card-head"><div><h3>Tester sur une machine</h3><p>Facultatif — vérifie la clé d’hôte et l’accès SSH</p></div></div>
      <div className="row">
        <input className="input grow" value={form.testHost} onChange={(e) => form.setTestHost(e.target.value)} placeholder="Adresse de la machine (ex. 192.168.1.20)" />
        <input className="input" style={{ width: 80 }} value={form.testPort} onChange={(e) => form.setTestPort(e.target.value)} />
        <button className="btn" onClick={() => void form.test()} disabled={form.state === 'testing'}>
          {form.state === 'testing' ? <RefreshCw size={14} className="spin" /> : <TerminalSquare size={14} />} Tester
        </button>
      </div>
      {form.hostKey && (
        <div className="row" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 9, background: 'var(--panel-2)', alignItems: 'center' }}>
          <KeyRound size={16} className="muted" />
          <div className="grow">
            <div className="faint" style={{ fontSize: 12 }}>Clé d’hôte présentée</div>
            <div className="mono selectable" style={{ overflowWrap: 'anywhere' }}>{form.hostKey.algorithm} SHA256:{form.hostKey.fingerprint}</div>
          </div>
          {form.trusted ? <Badge kind="success">Approuvée</Badge> : <button className="btn primary sm" onClick={form.approve}><ShieldCheck size={13} /> Approuver</button>}
        </div>
      )}
      {form.message && (
        <div style={{ marginTop: 10, color: form.state === 'failed' ? 'var(--danger)' : form.state === 'success' ? 'var(--success)' : 'var(--text-2)' }}>{form.message}</div>
      )}
      {form.tested && (
        <div style={{ marginTop: 12 }}>
          <Check checked={form.addTested} onChange={form.setAddTested}>Ajouter cette machine au centre de mises à jour</Check>
        </div>
      )}
    </div>
  )
}
