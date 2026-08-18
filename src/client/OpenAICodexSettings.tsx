/** Plugin-owned OpenAI Codex account page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { BrowserUiCommandResult } from '@dsh-std/ui-browser'
import type { OpenAICodexUsage } from '../usage.ts'
import type { ImageToolPreferences } from '../preferences.ts'
import type { ResponseApiPreferences } from '../preferences.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'

const POLL_INTERVAL_MS = 1_000
const USAGE_POLL_INTERVAL_MS = 60_000

type AccountStatus =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in'; message?: string }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'error'; message: string }

/** Dependencies injected by the browser plugin entry. */
export interface OpenAICodexSettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string
  /** Execute the component's standard command in one live DSH session. */
  runCommand(sessionId: string, line: string): Promise<BrowserUiCommandResult | undefined>
}

/** Props delivered by the settings slot renderer. */
export type OpenAICodexSettingsProps = Partial<OpenAICodexSettingsInjected> & {
  useSessions?<T>(selector: (state: { readonly current?: string }) => T): T
}

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-button-primary-fill)', background: 'var(--dsw-alias-button-primary-fill)', color: 'var(--dsw-alias-label-primary-foreground)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }
const quotaListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 2 }
const quotaGroupStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const quotaTitleStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '20px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const quotaLabelStyle: CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' }
const progressTrackStyle: CSSProperties = { height: 8, overflow: 'hidden', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))' }
const toggleRowStyle: CSSProperties = { ...rowStyle, flexWrap: 'nowrap', alignItems: 'flex-start' }
const toggleCopyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3 }
const toggleTrackStyle: CSSProperties = { position: 'relative', width: 40, height: 22, flex: '0 0 auto', marginTop: 1, padding: 0, border: 0, borderRadius: 999, cursor: 'pointer', transition: 'background 120ms ease' }

function PreferenceToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean
  disabled: boolean
  label: string
  onChange(value: boolean): void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      style={{
        ...toggleTrackStyle,
        opacity: disabled ? 0.55 : 1,
        background: checked ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2, #c8ccd2)',
      }}
      onClick={() => { onChange(!checked) }}
    >
      <span style={{
        position: 'absolute',
        top: 3,
        left: checked ? 21 : 3,
        width: 16,
        height: 16,
        borderRadius: '50%',
        background: 'var(--dsw-alias-label-primary-foreground)',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
        transition: 'left 120ms ease',
      }} />
    </button>
  )
}

function progressFillStyle(percent: number): CSSProperties {
  return {
    width: `${Math.max(0, Math.min(100, percent))}%`,
    height: '100%',
    borderRadius: 'inherit',
    background: 'var(--dsw-alias-brand-primary, #1677ff)',
  }
}

function windowLabel(seconds: number, t: OpenAICodexSettingsInjected['t']): string {
  if (seconds === 5 * 60 * 60) return t('fiveHourLimit')
  if (seconds === 7 * 24 * 60 * 60) return t('weeklyLimit')
  const hours = seconds / (60 * 60)
  return Number.isInteger(hours) ? t('hourLimit', { count: hours }) : t('usageWindow')
}

function formatPercent(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
}

function resetDetail(resetsAt: number | undefined, t: OpenAICodexSettingsInjected['t']): string | undefined {
  return resetsAt === undefined
    ? undefined
    : t('resetsAt', { time: new Date(resetsAt * 1_000).toLocaleString() })
}

function QuotaBar({
  label,
  percent,
  detail,
  t,
}: {
  label: string
  percent: number
  detail?: string | undefined
  t: OpenAICodexSettingsInjected['t']
}) {
  const display = formatPercent(percent)
  return (
    <div style={quotaGroupStyle}>
      <div style={quotaLabelStyle}>
        <span>{label}</span>
        <span>{t('percentRemaining', { percent: display })}</span>
      </div>
      <div
        style={progressTrackStyle}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={t('percentRemaining', { percent: display })}
      >
        <div style={progressFillStyle(percent)} />
      </div>
      {detail === undefined ? null : <p style={bodyStyle}>{detail}</p>}
    </div>
  )
}

function UsageLimits({ usage, quotaError, t }: {
  usage: OpenAICodexUsage
  quotaError?: string
  t: OpenAICodexSettingsInjected['t']
}) {
  const hasData = usage.rateLimits.length > 0 || usage.credits !== undefined || usage.individualLimit !== undefined
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('usageLimits')}</h3>
      {usage.rateLimits.map(limit => (
        <div key={limit.id} style={quotaGroupStyle}>
          <h4 style={quotaTitleStyle}>{limit.name ?? limit.id}</h4>
          {limit.windows.map(window => (
            <QuotaBar
              key={window.windowSeconds}
              label={windowLabel(window.windowSeconds, t)}
              percent={window.remainingPercent}
              detail={resetDetail(window.resetsAt, t)}
              t={t}
            />
          ))}
        </div>
      ))}
      {usage.individualLimit === undefined ? null : (
        <QuotaBar
          label={t('monthlyLimit')}
          percent={usage.individualLimit.remainingPercent}
          detail={[t('exactRemaining', {
            remaining: usage.individualLimit.remaining,
            limit: usage.individualLimit.limit,
          }), resetDetail(usage.individualLimit.resetsAt, t)].filter(Boolean).join(' · ')}
          t={t}
        />
      )}
      {usage.credits === undefined ? null : (
        <div style={quotaLabelStyle}>
          <span>{t('credits')}</span>
          <span>{usage.credits.unlimited
            ? t('unlimited')
            : usage.credits.balance === undefined ? t('available') : usage.credits.balance}</span>
        </div>
      )}
      {!hasData && quotaError === undefined ? <p style={bodyStyle}>{t('quotaUnavailable')}</p> : null}
      {quotaError === undefined ? null : <p style={errorStyle}>{t('quotaUnavailable')}</p>}
    </div>
  )
}

function dotStyle(status: AccountStatus['status']): CSSProperties {
  const color = status === 'signed-in'
    ? 'var(--dsw-alias-state-success-primary, #22a06b)'
    : status === 'error'
      ? 'var(--dsw-alias-state-error-primary, #d92d20)'
      : status === 'signing-in' || status === 'loading'
        ? 'var(--dsw-alias-brand-primary, #1677ff)'
        : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return { width: 9, height: 9, borderRadius: '50%', flex: '0 0 auto', background: color }
}

function commandText(result: BrowserUiCommandResult | undefined, line: string): string {
  if (result === undefined) throw new Error(`unknown command: ${line}`)
  if (result.kind === 'error') throw new Error(result.text ?? `command failed: ${line}`)
  return result.text ?? ''
}

function parseConfig(text: string): ImageToolPreferences & ResponseApiPreferences {
  const rows = new Map(text.split(/\r?\n/u).map(line => line.split(': ', 2) as [string, string]))
  const enabled = (key: string): boolean => {
    const value = rows.get(key)
    if (value !== 'on' && value !== 'off') throw new Error(`OpenAI Codex returned an invalid ${key} setting`)
    return value === 'on'
  }
  return {
    modifyReadImage: enabled('read-image'),
    shareImagegenWithOtherModels: enabled('imagegen-other-models'),
    useWebSocketContextReuse: enabled('websocket-context'),
    useNativeCompaction: enabled('native-compaction'),
  }
}

function parseUsage(text: string): OpenAICodexUsage {
  const limits = new Map<string, {
    id: string
    name: string
    windows: Array<OpenAICodexUsage['rateLimits'][number]['windows'][number]>
  }>()
  let credits: OpenAICodexUsage['credits']
  let individualLimit: OpenAICodexUsage['individualLimit']
  const parseDuration = (value: string): number => {
    const match = /^(\d+)(d|h|min|s)$/u.exec(value)
    if (match === null) return Number.NaN
    const multiplier = match[2] === 'd' ? 86_400 : match[2] === 'h' ? 3_600 : match[2] === 'min' ? 60 : 1
    return Number(match[1]) * multiplier
  }
  const parseReset = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const milliseconds = Date.parse(value)
    return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : undefined
  }
  for (const line of text.split(/\r?\n/u)) {
    const window = /^(.*?) \((\d+(?:d|h|min|s))\): (\d+(?:\.\d+)?)% remaining(?: · resets (.+))?$/u.exec(line)
    if (window !== null) {
      const name = window[1]!
      const entry = limits.get(name) ?? { id: name, name, windows: [] }
      const resetsAt = parseReset(window[4])
      entry.windows.push({
        windowSeconds: parseDuration(window[2]!),
        remainingPercent: Number(window[3]),
        ...resetsAt === undefined ? {} : { resetsAt },
      })
      limits.set(name, entry)
      continue
    }
    const individual = /^Individual limit: (\d+(?:\.\d+)?)% remaining \(([^/]+)\/([^\)]+)\)(?: · resets (.+))?$/u.exec(line)
    if (individual !== null) {
      const remaining = individual[2]!
      const limit = individual[3]!
      const remainingNumber = Number(remaining)
      const limitNumber = Number(limit)
      const resetsAt = parseReset(individual[4])
      individualLimit = {
        remainingPercent: Number(individual[1]), remaining, limit,
        used: Number.isFinite(remainingNumber) && Number.isFinite(limitNumber)
          ? String(limitNumber - remainingNumber)
          : '0',
        ...resetsAt === undefined ? {} : { resetsAt },
      }
      continue
    }
    const credit = /^Credits: (.+)$/u.exec(line)?.[1]
    if (credit !== undefined) credits = credit === 'unlimited'
      ? { unlimited: true }
      : { unlimited: false, ...(credit === 'available' ? {} : { balance: credit }) }
  }
  if (limits.size === 0 && credits === undefined && individualLimit === undefined
    && text !== 'OpenAI Codex usage is currently unavailable.') {
    throw new Error('OpenAI Codex returned an invalid usage projection')
  }
  return {
    rateLimits: [...limits.values()],
    ...(credits === undefined ? {} : { credits }),
    ...(individualLimit === undefined ? {} : { individualLimit }),
  }
}

/** OpenAI Codex account status and OAuth actions. */
export function OpenAICodexSettings({ t, runCommand, useSessions }: OpenAICodexSettingsProps) {
  if (t === undefined || runCommand === undefined || useSessions === undefined) {
    throw new Error('OpenAI Codex settings requires its standard Web dependencies')
  }
  const sessionId = useSessions(state => state.current)
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [imageTools, setImageTools] = useState<ImageToolPreferences | undefined>()
  const [imageToolsBusy, setImageToolsBusy] = useState(false)
  const [imageToolsError, setImageToolsError] = useState<string | undefined>()
  const [responseApi, setResponseApi] = useState<ResponseApiPreferences | undefined>()
  const [responseApiBusy, setResponseApiBusy] = useState(false)
  const [responseApiError, setResponseApiError] = useState<string | undefined>()

  const request = useCallback(async (line: string): Promise<string> => {
    if (sessionId === undefined) throw new Error(t('noSession'))
    return commandText(await runCommand(sessionId, line), line)
  }, [runCommand, sessionId, t])

  const refresh = useCallback(async () => {
    try {
      if (sessionId === undefined) throw new Error(t('noSession'))
      const account = await runCommand(sessionId, '/codex status')
      const text = account?.text ?? ''
      if (text.includes('waiting for approval')) {
        setStatus(current => current.status === 'signing-in' ? current : { status: 'signing-in' })
      } else if (account?.kind === 'success' && text.includes('is signed in')) {
        try {
          setStatus({ status: 'signed-in', usage: parseUsage(await request('/codex usage')) })
        } catch (error: unknown) {
          setStatus({
            status: 'signed-in', usage: { rateLimits: [] },
            quotaError: error instanceof Error ? error.message : t('quotaUnavailable'),
          })
        }
      } else if (text.includes('signed out')) {
        setStatus({ status: 'signed-out' })
      } else {
        throw new Error(text || t('requestFailed'))
      }
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    }
  }, [request, runCommand, sessionId, t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    void request('/codex config').then(
      value => { setImageTools(parseConfig(value)); setImageToolsError(undefined) },
      () => { setImageToolsError(t('imageToolSettingsFailed')) },
    )
  }, [request, t])
  useEffect(() => {
    void request('/codex config').then(
      value => { setResponseApi(parseConfig(value)); setResponseApiError(undefined) },
      () => { setResponseApiError(t('responseApiSettingsFailed')) },
    )
  }, [request, t])
  useEffect(() => {
    const interval = status.status === 'signing-in'
      ? POLL_INTERVAL_MS
      : status.status === 'signed-in' ? USAGE_POLL_INTERVAL_MS : undefined
    if (interval === undefined) return
    const timer = window.setInterval(() => { void refresh() }, interval)
    return () => { window.clearInterval(timer) }
  }, [refresh, status.status])

  const signIn = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank')
    if (popup !== null) popup.opener = null
    setBusy(true)
    setStatus({ status: 'signing-in' })
    try {
      const challenge = await request('/codex login device')
      const url = challenge.match(/https?:\/\/\S+/u)?.[0]
      setStatus({ status: 'signing-in', message: challenge })
      if (popup === null) {
        setStatus({ status: 'error', message: t('popupBlocked') })
        return
      }
      if (url === undefined) throw new Error('OpenAI Codex did not return a device authorization URL')
      popup.location.replace(url)
    } catch (error: unknown) {
      popup?.close()
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      await request('/codex logout')
      setStatus({ status: 'signed-out' })
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    } finally {
      setBusy(false)
    }
  }

  const updateImageTool = async (patch: Partial<ImageToolPreferences>): Promise<void> => {
    setImageToolsBusy(true)
    setImageToolsError(undefined)
    try {
      const [key, value] = Object.entries(patch)[0] ?? []
      const setting = key === 'modifyReadImage' ? 'read-image' : 'imagegen-other-models'
      setImageTools(parseConfig(await request(`/codex set ${setting} ${value === true ? 'on' : 'off'}`)))
    } catch {
      setImageToolsError(t('imageToolSettingsFailed'))
    } finally {
      setImageToolsBusy(false)
    }
  }

  const updateResponseApi = async (patch: Partial<ResponseApiPreferences>): Promise<void> => {
    setResponseApiBusy(true)
    setResponseApiError(undefined)
    try {
      const [key, value] = Object.entries(patch)[0] ?? []
      const setting = key === 'useWebSocketContextReuse' ? 'websocket-context' : 'native-compaction'
      setResponseApi(parseConfig(await request(`/codex set ${setting} ${value === true ? 'on' : 'off'}`)))
    } catch {
      setResponseApiError(t('responseApiSettingsFailed'))
    } finally {
      setResponseApiBusy(false)
    }
  }

  const label = status.status === 'signed-in'
    ? t('signedIn')
    : status.status === 'loading'
      ? t('loadingAccount')
      : status.status === 'signing-in'
      ? t('signingIn')
      : status.status === 'error'
        ? t('requestFailed')
        : t('signedOut')

  return (
    <section style={pageStyle} aria-labelledby="openai-codex-settings-title">
      <div>
        <h2 id="openai-codex-settings-title" style={titleStyle}>{t('title')}</h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <div style={statusStyle} role="status">
            <span aria-hidden="true" style={dotStyle(status.status)} />
            <span>{label}</span>
          </div>
          {status.status === 'loading'
            ? null
            : status.status === 'signed-in'
            ? <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void signOut() }}>{busy ? t('working') : t('logout')}</button>
            : <button type="button" style={primaryButtonStyle} disabled={busy || sessionId === undefined} onClick={() => { void signIn() }}>{busy ? t('working') : status.status === 'error' ? t('loginAgain') : t('login')}</button>}
        </div>
        {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
        {status.status === 'signing-in' && status.message !== undefined ? <p style={{ ...bodyStyle, whiteSpace: 'pre-wrap' }}>{status.message}</p> : null}
        {status.status === 'signed-in'
          ? <UsageLimits
              usage={status.usage}
              {...status.quotaError === undefined ? {} : { quotaError: status.quotaError }}
              t={t}
            />
          : null}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('imageTools')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('imageToolsIntro')}</p>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('modifyReadImage')}</span>
            <span style={bodyStyle}>{t('modifyReadImageHint')}</span>
          </span>
          <PreferenceToggle
            label={t('modifyReadImage')}
            disabled={imageTools === undefined || imageToolsBusy}
            checked={imageTools?.modifyReadImage ?? false}
            onChange={checked => { void updateImageTool({ modifyReadImage: checked }) }}
          />
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('shareImagegen')}</span>
            <span style={bodyStyle}>{t('shareImagegenHint')}</span>
          </span>
          <PreferenceToggle
            label={t('shareImagegen')}
            disabled={imageTools === undefined || imageToolsBusy}
            checked={imageTools?.shareImagegenWithOtherModels ?? false}
            onChange={checked => { void updateImageTool({ shareImagegenWithOtherModels: checked }) }}
          />
        </div>
        {imageToolsError === undefined ? null : <p style={errorStyle}>{imageToolsError}</p>}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('responseApi')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('responseApiIntro')}</p>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('webSocketContextReuse')}</span>
            <span style={bodyStyle}>{t('webSocketContextReuseHint')}</span>
          </span>
          <PreferenceToggle
            label={t('webSocketContextReuse')}
            disabled={responseApi === undefined || responseApiBusy}
            checked={responseApi?.useWebSocketContextReuse ?? false}
            onChange={checked => { void updateResponseApi({ useWebSocketContextReuse: checked }) }}
          />
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('nativeCompaction')}</span>
            <span style={bodyStyle}>{t('nativeCompactionHint')}</span>
          </span>
          <PreferenceToggle
            label={t('nativeCompaction')}
            disabled={responseApi === undefined || responseApiBusy}
            checked={responseApi?.useNativeCompaction ?? false}
            onChange={checked => { void updateResponseApi({ useNativeCompaction: checked }) }}
          />
        </div>
        {responseApiError === undefined ? null : <p style={errorStyle}>{responseApiError}</p>}
      </div>
    </section>
  )
}
