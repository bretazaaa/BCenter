import type { ApiResult } from '../shared/api'

declare global {
  interface Window {
    bcenter: {
      invoke(name: string, args: unknown[]): Promise<ApiResult<unknown>>
      on(event: string, listener: (payload: unknown) => void): () => void
    }
  }
}

export {}
