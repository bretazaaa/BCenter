import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import type { DetachSpec } from '@shared/types'
import { Splash } from './splash/Splash'
import { WebGate } from './web/WebGate'
import './styles.css'

// L'écran de démarrage ne charge que lui-même ; l'application et les fenêtres détachées sont chargées à la demande.
const App = lazy(() => import('./App').then((m) => ({ default: m.App })))
const DetachedWindow = lazy(() => import('./DetachedWindow').then((m) => ({ default: m.DetachedWindow })))

const route = window.location.hash.replace(/^#/, '')
const [path, query] = route.split('?')

function Root() {
  if (path === '/splash') return <Splash />
  if (path === '/detached') {
    const params = new URLSearchParams(query)
    const spec: DetachSpec = {
      kind: params.get('kind') === 'files' ? 'files' : 'shell',
      targetId: params.get('targetId') ?? '',
      sessionId: params.get('sessionId') ?? undefined,
      path: params.get('path') ?? undefined,
    }
    return <DetachedWindow spec={spec} />
  }
  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Navigateur (BCenter Server) : pas de pont Electron, connexion obligatoire avant l'application. */}
    {window.bcenter ? <Suspense fallback={null}><Root /></Suspense> : <WebGate><Suspense fallback={null}><Root /></Suspense></WebGate>}
  </StrictMode>,
)
