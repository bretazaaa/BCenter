const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po']
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 })

export function bytes(value: number | undefined): string {
  if (!value || value <= 0 || !Number.isFinite(value)) return '0 o'
  const order = Math.min(Math.floor(Math.log(value) / Math.log(1024)), UNITS.length - 1)
  const v = value / 1024 ** order
  return `${(v >= 100 ? nf0 : nf1).format(v)} ${UNITS[order]}`
}

export const rate = (value: number | undefined) => `${bytes(value)}/s`

export const pct = (value: number | undefined) => (value == null || Number.isNaN(value) ? '—' : `${nf0.format(value * 100)} %`)

export function uptime(seconds: number): string {
  if (!seconds || seconds <= 0) return '—'
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d >= 1 ? `${d} j ${h} h` : h >= 1 ? `${h} h ${m} min` : `${m} min`
}

export function relative(time: number | string | undefined | null): string {
  if (time == null) return '—'
  const t = typeof time === 'string' ? Date.parse(time) : time
  const s = (Date.now() - t) / 1000
  if (s < 45) return 'à l’instant'
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`
  if (s < 7 * 86_400) return `il y a ${Math.floor(s / 86_400)} j`
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })
}

export const clock = (time: number | string | null | undefined) =>
  time == null ? '—' : new Date(time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export const dateTime = (time: number | undefined) =>
  time == null ? '—' : new Date(time).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export function formatFingerprint(value: string): string {
  return (value.replace(/[^0-9a-f]/gi, '').toUpperCase().match(/.{2}/g) ?? []).join(':')
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`
