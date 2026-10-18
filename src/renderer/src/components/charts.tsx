import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface Series {
  key: string
  name: string
  color: string
  fill?: boolean
}

interface Props {
  data: Record<string, number | undefined>[]
  series: Series[]
  height?: number
  format: (v: number) => string
  timeFormat?: Intl.DateTimeFormatOptions
  domain?: [number, number]
  legend?: boolean
}

const AXIS = { stroke: '#646b77', fontSize: 11, tickLine: false, axisLine: false }

/** Graphique temporel à aires dégradées, aligné sur le design system. */
export function TimeChart({ data, series, height = 240, format, timeFormat = { hour: '2-digit', minute: '2-digit' }, domain, legend }: Props) {
  const fmtTime = (t: number) => new Date(t).toLocaleString('fr-FR', timeFormat)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity={0.32} />
              <stop offset="100%" stopColor={s.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke="#1e2129" strokeDasharray="4 4" vertical={false} />
        <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={fmtTime} minTickGap={40} {...AXIS} />
        <YAxis tickFormatter={format} width={64} domain={domain ?? [0, 'auto']} {...AXIS} />
        <Tooltip
          contentStyle={{ background: '#181a20', border: '1px solid #24262e', borderRadius: 8, fontSize: 12 }}
          labelStyle={{ color: '#a0a6b1', marginBottom: 4 }}
          labelFormatter={(t) => fmtTime(Number(t))}
          formatter={(v, name) => [format(Number(v)), name]}
        />
        {legend && <Legend iconType="plainline" wrapperStyle={{ fontSize: 12, color: '#a0a6b1' }} verticalAlign="top" height={26} />}
        {series.map((s) => (
          <Area
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            fill={s.fill === false ? 'transparent' : `url(#g-${s.key})`}
            isAnimationActive={false}
            dot={false}
            connectNulls
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  )
}
