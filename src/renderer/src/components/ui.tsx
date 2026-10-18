import { AlertTriangle, Info, X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import logoFull from '../assets/bcenter-logo.png'
import logoMark from '../assets/bcenter-mark.png'
import type { AlertSeverity, GuestStatus, JobStatus, NodeStatus } from '@shared/types'

/** Logo BCenter : « mark » (B seul, petites tailles) ou « full » (avec le nom, grandes tailles). */
export function Logo({ size = 22, variant = 'mark', className = '' }: { size?: number; variant?: 'mark' | 'full'; className?: string }) {
  return <img className={`logo ${className}`} src={variant === 'full' ? logoFull : logoMark} width={size} height={size} alt="BCenter" draggable={false} />
}

export function Card({ title, subtitle, actions, children, className = '' }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}

export function Stat({ label, value, detail, icon, color = 'var(--accent)', soft = 'var(--accent-soft)', onClick }: {
  label: string; value: ReactNode; detail?: ReactNode; icon: ReactNode; color?: string; soft?: string; onClick?: () => void
}) {
  return (
    <div className={`card stat${onClick ? ' clickable' : ''}`} onClick={onClick}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {detail && <div className="detail">{detail}</div>}
      <div className="ico" style={{ color, background: soft }}>{icon}</div>
    </div>
  )
}

export type BadgeKind = 'neutral' | 'success' | 'warning' | 'danger' | 'accent' | 'info'

export function Badge({ kind = 'neutral', children, plain = false }: { kind?: BadgeKind; children: ReactNode; plain?: boolean }) {
  return <span className={`badge ${kind}${plain ? ' plain' : ''}`}>{children}</span>
}

const STATUS: Record<string, [BadgeKind, string]> = {
  running: ['success', 'En marche'], stopped: ['neutral', 'Arrêtée'], paused: ['warning', 'En pause'],
  online: ['success', 'En ligne'], offline: ['danger', 'Hors ligne'], unknown: ['neutral', 'Inconnu'],
  queued: ['info', 'En attente'], succeeded: ['success', 'Terminée'], failed: ['danger', 'Échec'], cancelled: ['warning', 'Annulée'],
  critical: ['danger', 'Critique'], warning: ['warning', 'Avertissement'], info: ['info', 'Info'],
  ok: ['success', 'OK'],
}

export function StatusBadge({ status }: { status: GuestStatus | NodeStatus | JobStatus | AlertSeverity | 'ok' }) {
  const [kind, label] = STATUS[status] ?? ['neutral', status]
  return <Badge kind={kind}>{label}</Badge>
}

export function JobBadge({ status }: { status: JobStatus }) {
  if (status === 'running') return <Badge kind="accent">En cours</Badge>
  return <StatusBadge status={status} />
}

export function Usage({ value, warn = 0.75, crit = 0.9 }: { value: number; warn?: number; crit?: number }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))
  return (
    <div className={`usage${v >= crit ? ' crit' : v >= warn ? ' warn' : ''}`}>
      <div style={{ width: `${v * 100}%` }} />
    </div>
  )
}

export function Modal({ title, onClose, children, footer, width = 560 }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal>
        <div className="m-head">
          {title}
          <button className="btn ghost sm icon" onClick={onClose} aria-label="Fermer"><X size={15} /></button>
        </div>
        <div className="m-body">{children}</div>
        {footer && <div className="m-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </span>
  )
}

export function Check({ checked, onChange, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {children && <span>{children}</span>}
    </label>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  )
}

export function SettingRow({ title, description, children }: { title: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="text">
        <div>{title}</div>
        {description && <div>{description}</div>}
      </div>
      {children}
    </div>
  )
}

export function Empty({ icon, title, message, children }: { icon: ReactNode; title: string; message?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-tile">{icon}</div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {children}
    </div>
  )
}

export function Callout({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div className={`callout ${kind}`}>
      {kind === 'info' ? <Info size={16} /> : <AlertTriangle size={16} />}
      <div>{children}</div>
    </div>
  )
}

export function Progress({ value, indeterminate }: { value?: number; indeterminate?: boolean }) {
  return (
    <div className={`progress${indeterminate ? ' indeterminate' : ''}`}>
      <div style={indeterminate ? undefined : { width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  )
}
