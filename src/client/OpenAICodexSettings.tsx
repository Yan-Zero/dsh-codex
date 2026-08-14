/** Plugin-owned OpenAI Codex account page inside the dsh Settings shell. */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { OpenAICodexUsage } from '../usage.ts'
import type { ImageToolPreferences } from '../tool-policy.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'

const STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
const LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
const LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
const IMAGE_TOOLS_PATH = '/plugins/dsh-openai-codex/image-tools'
const POLL_INTERVAL_MS = 1_000
const USAGE_POLL_INTERVAL_MS = 60_000

type AccountStatus =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'error'; message: string }

interface LoginChallenge {
  url: string
}

/** Dependencies injected by the browser plugin entry. */
export interface OpenAICodexSettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot renderer. */
export type OpenAICodexSettingsProps = Partial<OpenAICodexSettingsInjected>

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 720 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const cardStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 14, padding: '18px 20px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12, background: 'var(--dsw-alias-bg-module-platform)' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }
const statusStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 9, fontSize: 15, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }
const buttonStyle: CSSProperties = { boxSizing: 'border-box', minHeight: 34, padding: '6px 14px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 18, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 14, cursor: 'pointer' }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, borderColor: 'var(--dsw-alias-brand-primary)', background: 'var(--dsw-alias-brand-primary)', color: 'white' }
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
        background: checked ? 'var(--dsw-alias-brand-primary, #1677ff)' : 'var(--dsw-alias-bg-layer-2, #c8ccd2)',
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
        background: 'white',
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

function QuotaBar({
  label,
  percent,
  detail,
  t,
}: {
  label: string
  percent: number
  detail?: string
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
              t={t}
            />
          ))}
        </div>
      ))}
      {usage.individualLimit === undefined ? null : (
        <QuotaBar
          label={t('monthlyLimit')}
          percent={usage.individualLimit.remainingPercent}
          detail={t('exactRemaining', {
            remaining: usage.individualLimit.remaining,
            limit: usage.individualLimit.limit,
          })}
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

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...body === undefined ? {} : { 'content-type': 'application/json' } },
    credentials: 'same-origin',
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
      ? value.error
      : `HTTP ${response.status}`
    throw new Error(message)
  }
  return value as T
}

/** OpenAI Codex account status and OAuth actions. */
export function OpenAICodexSettings({ t }: OpenAICodexSettingsProps) {
  if (t === undefined) throw new Error('OpenAI Codex settings requires its translation function')
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [imageTools, setImageTools] = useState<ImageToolPreferences | undefined>()
  const [imageToolsBusy, setImageToolsBusy] = useState(false)
  const [imageToolsError, setImageToolsError] = useState<string | undefined>()

  const refresh = useCallback(async () => {
    try {
      setStatus(await jsonRequest<AccountStatus>(STATUS_PATH))
    } catch (error: unknown) {
      setStatus({ status: 'error', message: error instanceof Error ? error.message : t('requestFailed') })
    }
  }, [t])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    void jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH).then(
      value => { setImageTools(value); setImageToolsError(undefined) },
      () => { setImageToolsError(t('imageToolSettingsFailed')) },
    )
  }, [t])
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
      const challenge = await jsonRequest<LoginChallenge>(LOGIN_PATH, 'POST')
      if (popup === null) {
        setStatus({ status: 'error', message: t('popupBlocked') })
        return
      }
      popup.location.replace(challenge.url)
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
      await jsonRequest<{ ok: true }>(LOGOUT_PATH, 'POST')
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
      setImageTools(await jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH, 'POST', patch))
    } catch {
      setImageToolsError(t('imageToolSettingsFailed'))
    } finally {
      setImageToolsBusy(false)
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
            : <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => { void signIn() }}>{busy ? t('working') : status.status === 'error' ? t('loginAgain') : t('login')}</button>}
        </div>
        {status.status === 'error' ? <p style={errorStyle}>{status.message}</p> : null}
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
            <span style={statusStyle}>{t('shareViewImage')}</span>
            <span style={bodyStyle}>{t('shareViewImageHint')}</span>
          </span>
          <PreferenceToggle
            label={t('shareViewImage')}
            disabled={imageTools === undefined || imageToolsBusy}
            checked={imageTools?.shareViewImageWithOtherModels ?? false}
            onChange={checked => { void updateImageTool({ shareViewImageWithOtherModels: checked }) }}
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
    </section>
  )
}
