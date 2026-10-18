import { contextBridge, ipcRenderer } from 'electron'

/**
 * Pont minimal et isolé : l'interface n'a accès ni à Node ni à Electron,
 * uniquement à l'appel des opérations du moteur et à l'écoute de ses événements.
 */
contextBridge.exposeInMainWorld('bcenter', {
  invoke: (name: string, args: unknown[]) => ipcRenderer.invoke('api', name, args),
  on: (event: string, listener: (payload: unknown) => void) => {
    const handler = (_: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on(`event:${event}`, handler)
    return () => ipcRenderer.removeListener(`event:${event}`, handler)
  },
})
