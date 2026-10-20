import { KeyRound, LogIn, ShieldAlert, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Callout, Field, Logo, Progress } from '../components/ui'
import { installWebBridge } from './bridge'

interface AuthState {
  configured: boolean
  authenticated: boolean
  https: boolean
  version: string
}

async function post<T>(path: string, body: object): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`)
  return data
}

/** Dans le navigateur : connexion (ou création du compte) avant d'afficher BCenter. */
export function WebGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/auth/state', { cache: 'no-store' })
      .then((r) => r.json() as Promise<AuthState>)
      .then(async (s) => {
        setState(s)
        if (s.authenticated) {
          await installWebBridge()
          setReady(true)
        }
      })
      .catch(() => setError('Serveur BCenter injoignable.'))
  }, [])

  if (ready) return <>{children}</>
  return (
    <div className="web-gate">
      <div className="web-card">
        <div style={{ textAlign: 'center', marginBottom: 18 }}><Logo size={88} variant="full" /></div>
        {error && <Callout kind="danger">{error}</Callout>}
        {!state && !error && <Progress indeterminate />}
        {state && !state.https && (
          <div style={{ marginBottom: 14 }}>
            <Callout kind="warning">Connexion non chiffrée (HTTP). Utilisez un reverse proxy HTTPS ou un VPN pour protéger vos identifiants.</Callout>
          </div>
        )}
        {state && !state.authenticated && (state.configured ? <Login /> : <Setup />)}
        {state && <div className="faint" style={{ textAlign: 'center', fontSize: 11.5, marginTop: 16 }}>BCenter Server {state.version}</div>}
      </div>
    </div>
  )
}

function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await post('/api/auth/login', { username, password, code })
      location.reload()
    } catch (err) {
      setError((err as Error).message)
      setCode('')
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)}>
      <h2 className="web-title">Connexion</h2>
      <Field label="Utilisateur"><input className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <Field label="Mot de passe"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label="Code de validation (application d’authentification)">
        <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
      </Field>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !username || !password || code.length !== 6}>
        <LogIn size={14} /> Se connecter
      </button>
    </form>
  )
}

function Setup() {
  const [setupCode, setSetupCode] = useState('')
  const [enrollment, setEnrollment] = useState<{ secret: string; qr: string } | null>(null)
  const [username, setUsername] = useState('admin')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      setEnrollment(await post('/api/auth/setup/start', { setupCode }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const finish = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) return setError('Les mots de passe ne correspondent pas.')
    setBusy(true)
    setError(null)
    try {
      await post('/api/auth/setup/finish', { setupCode, username, password, code })
      location.reload()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (!enrollment) {
    return (
      <form onSubmit={(e) => void start(e)}>
        <h2 className="web-title"><ShieldCheck size={18} /> Première connexion</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Saisissez le code d’installation affiché dans les journaux du serveur (<span className="mono">docker logs bcenter</span>). Il garantit que vous seul créez le compte administrateur.
        </p>
        <Field label="Code d’installation"><input className="input mono" autoFocus value={setupCode} onChange={(e) => setSetupCode(e.target.value)} placeholder="1234-5678-9012" /></Field>
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || !setupCode.trim()}><KeyRound size={14} /> Continuer</button>
      </form>
    )
  }

  return (
    <form onSubmit={(e) => void finish(e)}>
      <h2 className="web-title"><ShieldCheck size={18} /> Compte administrateur</h2>
      <div className="row" style={{ alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <img className="web-qr" src={enrollment.qr} alt="QR code à scanner" width={150} height={150} />
        <div className="muted" style={{ fontSize: 12.5 }}>
          Scannez ce code avec votre application d’authentification (Aegis, Google Authenticator, Bitwarden…), ou saisissez la clé :
          <div className="mono selectable" style={{ marginTop: 6, overflowWrap: 'anywhere', color: 'var(--text)' }}>{enrollment.secret}</div>
        </div>
      </div>
      <Field label="Utilisateur"><input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
      <div className="row">
        <div className="grow"><Field label="Mot de passe (12 caractères min.)"><input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field></div>
        <div className="grow"><Field label="Confirmation"><input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field></div>
      </div>
      <Field label="Code affiché par l’application">
        <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
      </Field>
      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}><ShieldAlert size={12} style={{ verticalAlign: -2, marginRight: 4 }} />Conservez la clé dans un endroit sûr : elle sera demandée à chaque connexion.</div>
      <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || password.length < 12 || code.length !== 6 || !username.trim()}>Créer le compte</button>
    </form>
  )
}
