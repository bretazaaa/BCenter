import { useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { Modal } from './ui'

interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  details?: string
}

interface DialogStore {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null
  confirm(options: ConfirmOptions): Promise<boolean>
}

/** Confirmation des opérations sensibles (asynchrone, depuis n'importe quel composant). */
export const useDialogs = create<DialogStore>((set) => ({
  current: null,
  confirm: (options) => new Promise<boolean>((resolve) => set({ current: { ...options, resolve } })),
}))

export const confirm = (options: ConfirmOptions) => useDialogs.getState().confirm(options)

export function DialogHost() {
  const current = useDialogs((s) => s.current)
  if (!current) return null
  const close = (ok: boolean) => {
    current.resolve(ok)
    useDialogs.setState({ current: null })
  }
  return (
    <Modal
      title={current.title}
      width={480}
      onClose={() => close(false)}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" onClick={() => close(false)}>Annuler</button>
          <button className={`btn ${current.danger ? 'danger' : 'primary'}`} onClick={() => close(true)} autoFocus>
            {current.confirmText ?? 'Confirmer'}
          </button>
        </>
      }
    >
      <div>{current.message}</div>
      {current.details && (
        <pre className="mono selectable" style={{ marginTop: 14, padding: '10px 12px', borderRadius: 8, background: 'var(--input)', color: 'var(--text-2)', whiteSpace: 'pre-wrap' }}>
          {current.details}
        </pre>
      )}
    </Modal>
  )
}

/** Gère l'état « occupé / erreur » d'une action de formulaire. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true)
    setError(null)
    try {
      return await action()
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, run }
}
