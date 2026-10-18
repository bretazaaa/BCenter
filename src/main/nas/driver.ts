import type { NasAction, NasProfile, NasSnapshot } from '@shared/types'

/** Données renvoyées par un pilote ; le moniteur y ajoute le profil, l'horodatage et l'accessibilité. */
export type NasData = Omit<NasSnapshot, 'nas' | 'timestamp' | 'reachable' | 'error'>

export interface NasSecrets {
  /** Clé API, mot de passe ou secret de jeton. */
  secret: string
  /** Jeton d'appareil approuvé (Synology, validation en deux étapes). */
  deviceToken?: string | null
  /** Code de validation en deux étapes saisi lors d'un test. */
  otp?: string
}

/** Pilote d'un système NAS : lecture de l'état et actions directes, sans passer par l'interface web. */
export interface NasDriver {
  test(): Promise<{ version: string; deviceToken?: string }>
  snapshot(signal?: AbortSignal): Promise<NasData>
  /** Exécute l'action et renvoie un message lisible (« Tâche lancée », …). */
  action(action: NasAction): Promise<string>
  close(): void
}

export type NasDriverFactory = (nas: NasProfile, secrets: NasSecrets) => NasDriver

/** Le compte exige un code de validation en deux étapes. */
export class NasOtpRequired extends Error {
  constructor() {
    super('Code de validation en deux étapes requis.')
  }
}

export class NasUnsupported extends Error {
  constructor(what: string) {
    super(`${what} n’est pas pris en charge sur ce NAS.`)
  }
}

export const emptyData = (): NasData => ({
  system: {}, pools: [], disks: [], shares: [], services: [], apps: [], tasks: [], alerts: [], capabilities: [],
})

/** Sépare un identifiant composé « type:valeur ». */
export function splitId(id: string): [string, string] {
  const i = id.indexOf(':')
  return i < 0 ? ['', id] : [id.slice(0, i), id.slice(i + 1)]
}

export const OP_LABEL = { start: 'Démarrage', stop: 'Arrêt', restart: 'Redémarrage' } as const
