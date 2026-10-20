import type { ApiResult } from '@shared/api'

type Listener = (payload: unknown) => void

/**
 * Version navigateur du pont Electron : les appels au moteur et ses événements passent par une WebSocket
 * authentifiée (cookie de session HttpOnly), avec reconnexion automatique.
 */
export function installWebBridge(): Promise<void> {
  const listeners = new Map<string, Set<Listener>>()
  const pending = new Map<number, (result: ApiResult<unknown>) => void>()
  const queue: string[] = []
  let ws: WebSocket | null = null
  let nextId = 1
  let delay = 1000

  const emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((l) => l(payload))

  const connected = new Promise<void>((resolve) => {
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws = socket
      socket.onopen = () => {
        delay = 1000
        while (queue.length) socket.send(queue.shift()!)
        emit('connection', true)
        resolve()
      }
      socket.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { id?: number; ok?: boolean; value?: unknown; error?: string; event?: string; payload?: unknown }
        if (msg.event) return emit(msg.event, msg.payload)
        const done = msg.id != null ? pending.get(msg.id) : undefined
        if (!done) return
        pending.delete(msg.id!)
        done(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: msg.error ?? 'Erreur' })
      }
      socket.onclose = (e) => {
        for (const [id, done] of pending) {
          pending.delete(id)
          done({ ok: false, error: 'Connexion au serveur BCenter perdue.' })
        }
        emit('connection', false)
        // Session expirée ou refusée : retour à l'écran de connexion.
        if (e.code === 4401 || e.code === 1008) return location.reload()
        setTimeout(() => void fetch('/api/auth/state').then((r) => r.json()).then((s: { authenticated: boolean }) => (s.authenticated ? connect() : location.reload())).catch(connect), delay)
        delay = Math.min(15_000, delay * 2)
      }
    }
    connect()
  })

  window.bcenter = {
    platform: 'web',
    invoke(name: string, args: unknown[]) {
      // Fenêtre détachée : un nouvel onglet du navigateur.
      if (name === 'openDetached') {
        const spec = args[0] as Record<string, string | undefined>
        const query = new URLSearchParams(Object.entries(spec).filter(([, v]) => v != null) as [string, string][])
        window.open(`/#/detached?${query}`, '_blank', 'noopener')
        return Promise.resolve({ ok: true, value: null })
      }
      return new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        const message = JSON.stringify({ id, name, args })
        if (ws?.readyState === WebSocket.OPEN) ws.send(message)
        else queue.push(message)
      })
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
    pathForFile: () => '',
  }
  return connected
}

export async function logout() {
  await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  location.reload()
}
