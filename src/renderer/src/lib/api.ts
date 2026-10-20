import type { BCenterApi, BCenterEvents } from '@shared/api'

/** Accès typé aux opérations du moteur (processus principal). */
export const api = new Proxy({} as BCenterApi, {
  get:
    (_target, name: string) =>
    async (...args: unknown[]) => {
      const result = await window.bcenter.invoke(name, args)
      if (!result.ok) throw new Error(result.error)
      return result.value
    },
})

export function on<K extends keyof BCenterEvents>(event: K, listener: (payload: BCenterEvents[K]) => void): () => void {
  return window.bcenter.on(event, listener as (payload: unknown) => void)
}

/** Interface servie par BCenter Server dans un navigateur (et non l'application Windows). */
export const isWeb = () => window.bcenter?.platform === 'web'
