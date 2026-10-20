import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { DetachSpec } from '@shared/types'
import { App } from './App'
import { DetachedWindow } from './DetachedWindow'
import { Splash } from './splash/Splash'
import './styles.css'

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
  <StrictMode><Root /></StrictMode>,
)
