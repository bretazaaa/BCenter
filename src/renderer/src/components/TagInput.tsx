import { X } from 'lucide-react'
import { useId, useState } from 'react'

const TAG_COLORS = ['#3b82f6', '#22d3ee', '#a78bfa', '#22c55e', '#f59e0b', '#f472b6', '#38bdf8', '#fb7185']

export function tagColor(tag: string): string {
  let hash = 0
  for (const ch of tag.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return TAG_COLORS[hash % TAG_COLORS.length]
}

/** Tag avec une couleur stable dérivée de son nom. */
export function TagPill({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const color = tagColor(tag)
  return (
    <span className="tag-pill" style={{ color, background: `${color}1f`, borderColor: `${color}40` }}>
      {tag}
      {onRemove && <button type="button" aria-label={`Retirer ${tag}`} onClick={onRemove}><X size={11} /></button>}
    </span>
  )
}

/** Saisie de tags : Entrée, virgule ou Tab pour ajouter ; suggestions parmi les tags déjà utilisés. */
export function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (tags: string[]) => void; suggestions: string[] }) {
  const [text, setText] = useState('')
  const listId = useId()
  const add = (raw: string) => {
    const tag = raw.trim().replace(/,$/, '').trim()
    if (tag && !value.some((t) => t.toLowerCase() === tag.toLowerCase())) onChange([...value, tag])
    setText('')
  }
  const available = suggestions.filter((s) => !value.some((t) => t.toLowerCase() === s.toLowerCase()))
  return (
    <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {value.map((t) => <TagPill key={t} tag={t} onRemove={() => onChange(value.filter((x) => x !== t))} />)}
      <input
        list={listId}
        value={text}
        placeholder={value.length ? '' : 'web, prod…'}
        onChange={(e) => {
          const v = e.target.value
          // Choix dans la liste de suggestions : ajout immédiat.
          if (available.includes(v)) add(v)
          else if (v.endsWith(',')) add(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => text.trim() && add(text)}
      />
      <datalist id={listId}>{available.map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  )
}
