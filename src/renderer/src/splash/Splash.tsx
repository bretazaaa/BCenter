import { useEffect, useState } from 'react'
import type { StartupProgress } from '@shared/types'
import { Logo } from '../components/ui'
import { api, on } from '../lib/api'
import './splash.css'

/** Écran de démarrage : logo animé et étapes réelles d'initialisation envoyées par le moteur. */
export function Splash() {
  const [progress, setProgress] = useState<StartupProgress>({ status: 'Démarrage…', progress: 0.03 })
  const [leaving, setLeaving] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    document.body.classList.add('transparent')
    void api.appInfo().then((i) => setVersion(i.version))
    return on('startup', (p) => {
      setProgress(p)
      if (p.progress >= 1 && !p.error) setLeaving(true)
    })
  }, [])

  return (
    <div className={`splash${leaving ? ' leaving' : ''}`}>
      <div className="splash-card">
        <div className="splash-hero">
          <div className="splash-logo">
            <div className="glow" />
            <Logo size={190} variant="full" className="splash-mark" />
            <div className="shine" />
          </div>
        </div>
        <div className="splash-foot">
          <div className="splash-status">
            <span className={progress.error ? 'error' : ''}>{progress.error ?? progress.status}</span>
            <span className="faint">{version && `Version ${version}`}</span>
          </div>
          <div className="progress"><div style={{ width: `${Math.round(progress.progress * 100)}%` }} /></div>
        </div>
      </div>
    </div>
  )
}
