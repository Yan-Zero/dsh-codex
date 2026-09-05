import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionUsage, TaskUsage, UsageBreakdownRow, UsageTimePoint, UsageTotals } from '../usage-ledger.ts'
import { isUsageSelection } from './usage-ui-data.ts'
import type { CodexHudModelDirectory } from './usage-ui-data.ts'

const API = '/plugins/dsh-openai-codex/usage'
const border = '1px solid color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 62%, transparent)'
const button: CSSProperties = {
  color: 'inherit', background: 'var(--dsw-alias-bg-layer-1, transparent)', border,
  borderRadius: 8, padding: '5px 10px', minHeight: 32, cursor: 'pointer', font: 'inherit', fontSize: 12,
}
const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #9ca3af)' }

interface CurrentSessionPayload {
  session: SessionUsage | null
  showUsageHud: boolean
  pinUsageHud: boolean
}

function tokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/** Live decode-throughput reading from the optional dsh-live-tps host unit. */
interface LiveTpsReading { tps: number | null; updatedAt: number | null }

/** A live reading this old is stale; the last one lingers for a fade. */
const LIVE_TPS_FADE_MS = 5_000

/** Compact live-TPS number: whole under ten gets one decimal. */
function formatTps(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return '0'
  return tps >= 10 ? String(Math.round(tps)) : String(Math.round(tps * 10) / 10)
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store', signal: signal ?? null })
  if (!response.ok) throw new Error(`Usage API ${response.status}`)
  return response.json() as Promise<T>
}

function Hud({ sessionId, modelDirectory, useProjection }: { sessionId?: string; modelDirectory: CodexHudModelDirectory; useProjection: UseProjection }) {
  const [payload, setPayload] = useState<CurrentSessionPayload>()
  const selection = useSyncExternalStore(
    modelDirectory.store.subscribe,
    modelDirectory.store.getSnapshot,
    modelDirectory.store.getSnapshot,
  ).current
  const active = isUsageSelection(selection)
  // Live instantaneous decode rate (dsh-live-tps host unit); absent when the
  // unit is not mounted — the trailing span drops out wholesale. The key is
  // not in this program's SessionProjectionMap, hence the duck-typed read.
  const liveTps = (useProjection as unknown as (key: string) => LiveTpsReading | undefined)('liveTps')
  const liveTpsActive = liveTps?.tps !== undefined && liveTps.tps !== null && liveTps.tps > 0
  // One-second fade clock: restarted by each new reading (updatedAt) and
  // self-stopping once the fade has elapsed, so the chip goes quiet ~5s
  // after streaming stops.
  const liveTpsLastUpdate = liveTpsActive ? liveTps.updatedAt : null
  const [liveTpsNow, setLiveTpsNow] = useState(() => Date.now())
  useEffect(() => {
    if (liveTpsLastUpdate === null) return
    setLiveTpsNow(Date.now())
    const id = window.setInterval(() => { setLiveTpsNow(Date.now()) }, 1_000)
    const stop = window.setTimeout(() => {
      window.clearInterval(id)
      setLiveTpsNow(Date.now())
    }, LIVE_TPS_FADE_MS + 1_000)
    return () => { window.clearTimeout(stop); window.clearInterval(id) }
  }, [liveTpsLastUpdate])
  const liveTpsFresh = liveTpsLastUpdate !== null && liveTpsNow - liveTpsLastUpdate <= LIVE_TPS_FADE_MS
  const refresh = useCallback(() => {
    if (sessionId === undefined || sessionId === '' || !active) return setPayload(undefined)
    void getJson<CurrentSessionPayload>(`/current-session?sessionId=${encodeURIComponent(sessionId)}`).then(setPayload, () => {})
  }, [active, sessionId])
  useEffect(() => { void modelDirectory.load().catch(() => {}) }, [modelDirectory])
  useEffect(() => {
    refresh()
    if (!active) return
    const timer = window.setInterval(refresh, 5_000)
    return () => { window.clearInterval(timer) }
  }, [active, refresh])
  if (!active || payload === undefined || payload.showUsageHud === false) return null
  const usage = payload.session
  return <div style={{
    boxSizing: 'border-box', width: 'calc(100% - 2 * var(--dsh-composer-side-clearance))',
    maxWidth: 'var(--dsh-composer-card-max-width)', margin: '0 auto',
    display: 'flex', justifyContent: 'flex-start', pointerEvents: 'none',
  }}>
    <output aria-label="Session token usage" title="Provider-reported token usage for this DSH session." style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '3px 8px',
      borderRadius: 999, border: payload.pinUsageHud ? border : '1px solid transparent',
      background: payload.pinUsageHud ? 'color-mix(in srgb, var(--dsw-alias-bg-layer-1, #111827) 72%, transparent)' : 'transparent',
      color: 'var(--dsw-alias-label-secondary, #9ca3af)', fontSize: 10, lineHeight: '14px',
      fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
    }}>
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--dsw-alias-brand-primary, #8b5cf6)' }} />
      <span>{selection?.provider}/{selection?.model}</span>
      <strong style={{ color: 'var(--dsw-alias-label-primary, #e5e7eb)', fontWeight: 600 }}>{tokens(usage?.totalTokens ?? 0)} tok</strong>
      <span>in {tokens(usage?.inputTokens ?? 0)}</span>
      <span>out {tokens(usage?.outputTokens ?? 0)}</span>
      {(usage?.cachedInputTokens ?? 0) === 0 ? null : <span>cache {tokens(usage?.cachedInputTokens ?? 0)}</span>}
      {liveTpsFresh && liveTps !== undefined && liveTps.tps !== null ? <span>{formatTps(liveTps.tps)} tps</span> : null}
    </output>
  </div>
}

function query(range: string, provider: string, model: string, reasoning: string): string {
  const params = new URLSearchParams({ range })
  if (provider !== '') params.set('provider', provider)
  if (model !== '') params.set('model', model)
  if (reasoning !== '') params.set('reasoning', reasoning)
  return params.toString()
}

function Breakdown({ title, rows }: { title: string; rows: UsageBreakdownRow[] }) {
  const maximum = Math.max(1, ...rows.map(row => row.totalTokens))
  return <section style={{ borderTop: border, padding: '16px 0' }}><h2 style={{ marginTop: 0, fontSize: 13 }}>{title}</h2>
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead><tr><th align="left">Name</th><th align="right">Tokens</th><th align="right">Requests</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.key} style={{ borderTop: border }}>
        <td style={{ padding: '8px 12px 8px 0', minWidth: 120 }}>
          <div style={{ marginBottom: 5 }}>{row.label}</div>
          <div aria-label={row.label + ': ' + tokens(row.totalTokens) + ' tokens'} style={{ height: 6, borderRadius: 99, overflow: 'hidden', background: 'color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 55%, transparent)' }}>
            <div style={{ width: row.totalTokens / maximum * 100 + '%', height: '100%', borderRadius: 99, background: 'var(--dsw-alias-brand-primary, #8b5cf6)' }} />
          </div>
        </td><td align="right">{tokens(row.totalTokens)}</td><td align="right">{row.requests}</td>
      </tr>)}</tbody>
    </table>
  </section>
}

const SERIES_COLORS = ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#06b6d4']

function TimeSeriesChart({ points, range }: { points: UsageTimePoint[]; range: string }) {
  const [mode, setMode] = useState<'line' | 'bar'>('line')
  const [hovered, setHovered] = useState<{
    point: UsageTimePoint
    x: number
    y: number
    color: string
  }>()
  const valid = points.filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.tokens))
  const totals = new Map<string, number>()
  for (const point of valid) totals.set(point.provider, (totals.get(point.provider) ?? 0) + point.tokens)
  const providers = [...totals.keys()].sort((left, right) => (totals.get(right) ?? 0) - (totals.get(left) ?? 0))
  if (valid.length === 0) return <section style={{ borderTop: border, padding: '16px 0' }}>
    <h2 style={{ margin: '0 0 4px', fontSize: 13 }}>Token Usage Over Time</h2>
    <div style={{ ...muted, fontSize: 12 }}>No recorded token usage in this range.</div>
  </section>

  const timestamps = [...new Set(valid.map(point => point.timestamp))].sort((left, right) => left - right)
  const timestampIndex = new Map(timestamps.map((timestamp, index) => [timestamp, index]))
  const minimumTime = timestamps[0] ?? 0
  const maximumTime = timestamps[timestamps.length - 1] ?? minimumTime
  const maximumTokens = Math.max(1, ...valid.map(point => point.tokens))
  const width = 960
  const height = 300
  const left = 68
  const right = 18
  const top = 20
  const bottom = 42
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const lineX = (timestamp: number) => maximumTime === minimumTime
    ? left + plotWidth / 2
    : left + (timestamp - minimumTime) / (maximumTime - minimumTime) * plotWidth
  const y = (value: number) => top + plotHeight - value / maximumTokens * plotHeight
  const byProvider = new Map(providers.map(provider => [
    provider,
    valid.filter(point => point.provider === provider).sort((a, b) => a.timestamp - b.timestamp),
  ]))
  const tickIndexes = [...new Set([0, 1, 2, 3, 4].map(index => Math.round(index * (timestamps.length - 1) / 4)))]
  const isHourly = maximumTime - minimumTime <= 2 * 86_400_000
  const dateFormat = new Intl.DateTimeFormat(undefined, isHourly
    ? { month: 'short', day: 'numeric', hour: '2-digit' }
    : { month: 'short', day: 'numeric' })
  const detailDateFormat = new Intl.DateTimeFormat(undefined, isHourly
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' })
  const groupSlot = plotWidth / Math.max(1, timestamps.length)
  const groupWidth = Math.min(52, groupSlot * 0.76)
  const barGap = providers.length > 1 ? 2 : 0
  const barWidth = Math.max(2, (groupWidth - barGap * Math.max(0, providers.length - 1)) / Math.max(1, providers.length))
  const barLeft = (point: UsageTimePoint, providerIndex: number) => {
    const index = timestampIndex.get(point.timestamp) ?? 0
    return left + (index + 0.5) * groupSlot - groupWidth / 2 + providerIndex * (barWidth + barGap)
  }
  const showDetail = (point: UsageTimePoint, x: number, color: string): void => {
    setHovered({ point, x, y: y(point.tokens), color })
  }
  const tooltipX = hovered === undefined ? 0 : hovered.x > width - 230 ? hovered.x - 220 : hovered.x + 10
  const tooltipY = hovered === undefined ? 0 : Math.max(top, hovered.y - 68)

  return <section style={{ borderTop: border, padding: '16px 0' }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div>
        <h2 style={{ margin: '0 0 4px', fontSize: 13 }}>Token Usage Over Time</h2>
        <div style={{ ...muted, fontSize: 11 }}>Time on the x-axis · provider token usage on the y-axis · {range}</div>
      </div>
      <div role="group" aria-label="Chart type" style={{ display: 'inline-flex', gap: 4 }}>
        {(['line', 'bar'] as const).map(value => <button
          key={value}
          type="button"
          aria-pressed={mode === value}
          style={{ ...button, minHeight: 28, padding: '3px 9px', background: mode === value ? 'var(--dsw-alias-brand-primary, #8b5cf6)' : button.background, color: mode === value ? '#fff' : 'inherit' }}
          onClick={() => { setMode(value); setHovered(undefined) }}
        >{value === 'line' ? 'Line' : 'Bars'}</button>)}
      </div>
    </div>
    <div style={{ display: 'flex', gap: '6px 14px', flexWrap: 'wrap', marginTop: 8, ...muted, fontSize: 11 }}>
      {providers.map((provider, index) => <span key={provider}>
        <i aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: mode === 'line' ? 99 : 2, marginRight: 5, background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
        {provider}
      </span>)}
    </div>
    <div style={{ width: '100%', minWidth: 0, overflow: 'hidden', marginTop: 10 }}>
      <svg role="img" aria-label={`Provider token usage over time, ${mode} chart`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style={{ display: 'block', width: '100%', maxWidth: '100%', height: 'auto', color: 'var(--dsw-alias-label-secondary, #9ca3af)' }}>
        {[0, 1, 2, 3, 4].map(index => {
          const value = maximumTokens * (4 - index) / 4
          const vertical = top + plotHeight * index / 4
          return <g key={index}>
            <line x1={left} x2={width - right} y1={vertical} y2={vertical} stroke="currentColor" strokeOpacity={0.18} />
            <text x={left - 10} y={vertical + 4} textAnchor="end" fill="currentColor" fontSize={10}>{tokens(value)}</text>
          </g>
        })}
        {tickIndexes.map(index => {
          const timestamp = timestamps[index]
          if (timestamp === undefined) return null
          const position = mode === 'bar' ? left + (index + 0.5) * groupSlot : lineX(timestamp)
          return <text key={timestamp} x={position} y={height - 12} textAnchor="middle" fill="currentColor" fontSize={10}>{dateFormat.format(new Date(timestamp))}</text>
        })}
        {providers.map((provider, providerIndex) => {
          const series = byProvider.get(provider) ?? []
          const color = SERIES_COLORS[providerIndex % SERIES_COLORS.length] ?? '#8b5cf6'
          if (mode === 'bar') return <g key={provider}>
            {series.map(point => {
              const x = barLeft(point, providerIndex)
              const barHeight = top + plotHeight - y(point.tokens)
              const label = `${provider}, ${detailDateFormat.format(new Date(point.timestamp))}: ${tokens(point.tokens)} tokens, ${point.requests} requests`
              return <rect
                key={point.timestamp}
                x={x}
                y={y(point.tokens)}
                width={barWidth}
                height={Math.max(1, barHeight)}
                rx={Math.min(3, barWidth / 3)}
                fill={color}
                fillOpacity={0.82}
                stroke={color}
                tabIndex={0}
                aria-label={label}
                onMouseEnter={() => { showDetail(point, x + barWidth / 2, color) }}
                onMouseLeave={() => { setHovered(undefined) }}
                onFocus={() => { showDetail(point, x + barWidth / 2, color) }}
                onBlur={() => { setHovered(undefined) }}
              />
            })}
          </g>
          const path = series.map((point, pointIndex) => `${pointIndex === 0 ? 'M' : 'L'} ${lineX(point.timestamp)} ${y(point.tokens)}`).join(' ')
          return <g key={provider}>
            <path d={path} fill="none" stroke={color} strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
            {series.map(point => {
              const label = `${provider}, ${detailDateFormat.format(new Date(point.timestamp))}: ${tokens(point.tokens)} tokens, ${point.requests} requests`
              return <g key={point.timestamp}>
                <circle cx={lineX(point.timestamp)} cy={y(point.tokens)} r={3.5} fill={color} />
                <circle
                  cx={lineX(point.timestamp)}
                  cy={y(point.tokens)}
                  r={11}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={label}
                  onMouseEnter={() => { showDetail(point, lineX(point.timestamp), color) }}
                  onMouseLeave={() => { setHovered(undefined) }}
                  onFocus={() => { showDetail(point, lineX(point.timestamp), color) }}
                  onBlur={() => { setHovered(undefined) }}
                />
              </g>
            })}
          </g>
        })}
        {hovered === undefined ? null : <g pointerEvents="none">
          <line x1={hovered.x} x2={hovered.x} y1={top} y2={top + plotHeight} stroke={hovered.color} strokeOpacity={0.35} strokeDasharray="3 4" />
          <rect x={tooltipX} y={tooltipY} width={210} height={58} rx={7} fill="#111827" stroke={hovered.color} strokeWidth={1.5} />
          <text x={tooltipX + 10} y={tooltipY + 17} fill="#d1d5db" fontSize={10}>{detailDateFormat.format(new Date(hovered.point.timestamp))}</text>
          <text x={tooltipX + 10} y={tooltipY + 34} fill="#fff" fontSize={11} fontWeight={600}>{hovered.point.provider}</text>
          <text x={tooltipX + 10} y={tooltipY + 49} fill="#d1d5db" fontSize={10}>{tokens(hovered.point.tokens)} tokens · {hovered.point.requests} requests</text>
        </g>}
      </svg>
    </div>
  </section>
}

interface AnalyticsData {
  summary: UsageTotals
  timeseries: UsageTimePoint[]
  providers: UsageBreakdownRow[]
  models: UsageBreakdownRow[]
  reasoning: UsageBreakdownRow[]
  tasks: TaskUsage[]
}

function Analytics() {
  const [range, setRange] = useState('7d')
  const [provider, setProvider] = useState('')
  const [model, setModel] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [data, setData] = useState<AnalyticsData>()
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const requestRef = useRef<AbortController | undefined>(undefined)
  const suffix = useMemo(() => '?' + query(range, provider, model, reasoning), [range, provider, model, reasoning])
  const refresh = useCallback(() => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    void getJson<AnalyticsData>('/analytics' + suffix, controller.signal).then(value => {
      if (controller.signal.aborted) return
      setData(value)
      setError(undefined)
      setLoading(false)
    }, reason => {
      if (controller.signal.aborted) return
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  }, [suffix])
  useEffect(() => {
    refresh()
    return () => { requestRef.current?.abort() }
  }, [refresh])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) refresh()
    }, 10_000)
    return () => { window.clearInterval(timer) }
  }, [refresh])
  const summary = data?.summary
  return <div style={{ width: '100%', maxWidth: 1180, color: 'var(--dsw-alias-label-primary,#e5e7eb)' }}>
    <h1 style={{ marginBottom: 4, fontSize: 20 }}>LLM Usage Analytics</h1>
    <div style={muted}>Provider-reported tokens recorded locally by DSH; no account quota is queried.</div>
    <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', margin: '16px 0' }}>
      <select aria-label="Time range" value={range} onChange={event => { setRange(event.currentTarget.value) }} style={button}>
        {['today', '24h', '7d', 'this-week', '30d', '90d', 'all'].map(value => <option key={value}>{value}</option>)}
      </select>
      <select aria-label="Provider" value={provider} onChange={event => { setProvider(event.currentTarget.value); setModel('') }} style={button}>
        <option value="">All providers</option>{data?.providers.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <select aria-label="Model" value={model} onChange={event => { setModel(event.currentTarget.value) }} style={button}>
        <option value="">All models</option>{data?.models.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <select aria-label="Reasoning effort" value={reasoning} onChange={event => { setReasoning(event.currentTarget.value) }} style={button}>
        <option value="">All reasoning</option>{data?.reasoning.map(row => <option key={row.key}>{row.key}</option>)}
      </select>
      <button style={button} onClick={refresh}>Refresh</button>
      <span role="status" style={{ ...muted, alignSelf: 'center', fontSize: 11 }}>{loading ? data === undefined ? 'Loading…' : 'Updating…' : 'Up to date'}</span>
    </div>
    {error === undefined ? null : <div style={{ color: '#f59e0b' }}>{error}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 20, padding: '16px 0', borderTop: border }}>
      {[
        ['Total', summary?.totalTokens ?? 0], ['Input', summary?.inputTokens ?? 0],
        ['Output', summary?.outputTokens ?? 0], ['Cached input', summary?.cachedInputTokens ?? 0],
        ['Requests', summary?.requests ?? 0], ['Sessions', summary?.sessions ?? 0],
      ].map(([label, value]) => <div key={String(label)}><div style={{ ...muted, fontSize: 10, textTransform: 'uppercase' }}>{label}</div>
        <strong style={{ display: 'block', fontSize: 20, marginTop: 4 }}>{label === 'Requests' || label === 'Sessions' ? value : tokens(Number(value))}</strong></div>)}
    </div>
    <TimeSeriesChart points={data?.timeseries ?? []} range={range} />
    <section style={{ borderTop: border, padding: '16px 0' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 13 }}>Token Composition</h2>
      {(() => {
        const input = summary?.inputTokens ?? 0
        const cached = Math.min(input, summary?.cachedInputTokens ?? 0)
        const parts = [
          { label: 'Uncached input', value: Math.max(0, input - cached), color: '#8b5cf6' },
          { label: 'Cached input', value: cached, color: '#3b82f6' },
          { label: 'Output', value: summary?.outputTokens ?? 0, color: '#10b981' },
        ]
        const total = Math.max(1, parts.reduce((sum, part) => sum + part.value, 0))
        return <><div aria-label="Token composition chart" style={{ display: 'flex', width: '100%', height: 14, borderRadius: 99, overflow: 'hidden', background: 'color-mix(in srgb, var(--dsw-alias-border-l2, #374151) 55%, transparent)' }}>
          {parts.map(part => part.value === 0 ? null : <div key={part.label} title={part.label + ': ' + tokens(part.value)} style={{ width: part.value / total * 100 + '%', background: part.color, minWidth: 2 }} />)}
        </div><div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 18px', marginTop: 10, ...muted, fontSize: 11 }}>
          {parts.map(part => <span key={part.label}><i aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: part.color, marginRight: 5 }} />{part.label} {tokens(part.value)}</span>)}
        </div></>
      })()}
    </section>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))', gap: 18 }}>
      <Breakdown title="Providers" rows={data?.providers ?? []} />
      <Breakdown title="Exact Models" rows={data?.models ?? []} />
      <Breakdown title="Reasoning" rows={data?.reasoning ?? []} />
    </div>
    <section style={{ borderTop: border, padding: '16px 0', overflowX: 'auto' }}><h2 style={{ fontSize: 13 }}>Recent Tasks</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 720 }}>
        <thead><tr><th align="left">Provider</th><th align="left">Model</th><th align="left">Reasoning</th><th align="right">Requests</th><th align="right">Tokens</th></tr></thead>
        <tbody>{data?.tasks.map(task => <tr key={task.taskId} style={{ borderTop: border }}>
          <td style={{ padding: '8px 0' }}>{task.provider}</td><td>{task.model}</td><td>{task.reasoningEffort}</td><td align="right">{task.requests}</td><td align="right">{tokens(task.totalTokens)}</td>
        </tr>)}</tbody>
      </table>
    </section>
  </div>
}

export function CodexUsageHud(props: { sessionId?: string; modelDirectory: CodexHudModelDirectory; useProjection?: UseProjection }) { return <Hud {...props} useProjection={props.useProjection ?? (() => undefined)} /> }
export function CodexUsageAnalyticsSettings() { return <Analytics /> }
