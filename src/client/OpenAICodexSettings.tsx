/** Plugin-owned OpenAI Codex account page inside the dsh Settings shell. */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { OpenAICodexUsage } from '../usage.ts'
import type {
  ContextWindowPreferences,
  FastModePreferences,
  ImageToolPreferences,
  ModelCatalogEntry,
  ModelCatalogSettings,
  ResponseApiPreferences,
} from '../tool-policy.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'
import type { OpenAICodexProxyMode, ProxyPreferences } from '../proxy.ts'

const ACCOUNTS_PATH = '/plugins/dsh-openai-codex/accounts'
interface AccountsOverview {
  selectedAccountId: string
  autoSwitch: boolean
  accounts: Array<{ id: string; name: string; authenticated: boolean; error?: string }>
}

const STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'
const LOCAL_STATUS_PATH = '/plugins/dsh-openai-codex/auth/local-status'
const LOGIN_PATH = '/plugins/dsh-openai-codex/auth/login'
const DEVICE_LOGIN_PATH = '/plugins/dsh-openai-codex/auth/device-login'
const LOGOUT_PATH = '/plugins/dsh-openai-codex/auth/logout'
const IMAGE_TOOLS_PATH = '/plugins/dsh-openai-codex/image-tools'
const RESPONSE_API_PATH = '/plugins/dsh-openai-codex/response-api'
const MODEL_CATALOG_PATH = '/plugins/dsh-openai-codex/models'
const CONTEXT_WINDOW_PATH = '/plugins/dsh-openai-codex/context-window'
const FAST_MODE_SETTINGS_PATH = '/plugins/dsh-openai-codex/fast-mode-default'
const PROXY_PATH = '/plugins/dsh-openai-codex/proxy'
const POLL_INTERVAL_MS = 1_000
const USAGE_POLL_INTERVAL_MS = 60_000

type AccountStatus =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signing-in' }
  | { status: 'reauth-required'; message: string }
  | { status: 'signed-in'; usage: OpenAICodexUsage; quotaError?: string }
  | { status: 'remote-web-origin-not-trusted' }
  | { status: 'error'; message: string }

interface LocalAccountStatus {
  authenticated: boolean
}

type LoginChallenge =
  | { method: 'browser'; url: string }
  | { method: 'device_code'; url: string; code: string }

/** Dependencies injected by the browser plugin entry. */
export interface OpenAICodexSettingsInjected {
  /** Localized page copy. */
  t: (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string
}

/** Props delivered by the settings slot renderer. */
export type OpenAICodexSettingsProps = Partial<OpenAICodexSettingsInjected>

const pageStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  maxWidth: 720,
}
const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  lineHeight: '28px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}
const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-secondary)',
}
const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '18px 20px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 12,
  background: 'var(--dsw-alias-bg-module-platform)',
}
const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexWrap: 'wrap',
  gap: 12,
}
const statusStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  fontSize: 15,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary)',
}
const buttonStyle: CSSProperties = {
  boxSizing: 'border-box',
  minHeight: 34,
  padding: '6px 14px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 18,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  cursor: 'pointer',
}
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  borderColor: 'var(--dsw-alias-button-primary-fill)',
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-foreground)',
}
const errorStyle: CSSProperties = {
  ...bodyStyle,
  color: 'var(--dsw-alias-state-error-primary)',
}
const quotaListStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  paddingTop: 2,
}
const quotaGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}
const quotaTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary)',
}
const quotaLabelStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  fontSize: 13,
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-secondary)',
}
const progressTrackStyle: CSSProperties = {
  height: 8,
  overflow: 'hidden',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08))',
}
const toggleRowStyle: CSSProperties = {
  ...rowStyle,
  flexWrap: 'nowrap',
  alignItems: 'flex-start',
}
const toggleCopyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
}
const toggleTrackStyle: CSSProperties = {
  position: 'relative',
  width: 40,
  height: 22,
  flex: '0 0 auto',
  marginTop: 1,
  padding: 0,
  border: 0,
  borderRadius: 999,
  cursor: 'pointer',
  transition: 'background 120ms ease',
}
const selectStyle: CSSProperties = {
  minWidth: 132,
  minHeight: 34,
  padding: '5px 30px 5px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
}
const modelListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 10,
}
const modelCardStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 12,
  padding: 12,
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 10,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
}
const modelCardHeaderStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
}
const modelMetadataStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: 5,
}
const modelFieldStyle: CSSProperties = {
  display: 'flex',
  minWidth: 0,
  alignItems: 'baseline',
  gap: 5,
}
const modelFieldLabelStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11,
  lineHeight: '16px',
}
const modelNameStyle: CSSProperties = {
  fontSize: 14,
  lineHeight: '20px',
  fontWeight: 600,
}
const modelIdStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary)',
}
const modelWindowStyle: CSSProperties = {
  fontSize: 13,
  lineHeight: '18px',
  whiteSpace: 'nowrap',
}
const modelEnableStyle: CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  alignItems: 'center',
  gap: 7,
  cursor: 'pointer',
}
const numberInputStyle: CSSProperties = {
  boxSizing: 'border-box',
  width: 180,
  minHeight: 36,
  padding: '7px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
}
const proxyModeStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  overflow: 'hidden',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 999,
  background: 'var(--dsw-alias-bg-layer-1)',
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)',
}
const proxyModeButtonStyle: CSSProperties = {
  boxSizing: 'border-box',
  minWidth: 0,
  minHeight: 40,
  padding: '8px 12px',
  border: 0,
  borderRadius: 0,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary)',
  font: 'inherit',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  transition: 'background 140ms ease, color 140ms ease',
}
const proxyInputStyle: CSSProperties = {
  ...numberInputStyle,
  width: 'auto',
  flex: '1 1 320px',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
}
const commandStyle: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  overflowX: 'auto',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.06))',
  color: 'var(--dsw-alias-label-primary)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  lineHeight: '20px',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}
const deviceCodeStyle: CSSProperties = {
  ...commandStyle,
  alignSelf: 'flex-start',
  paddingInline: 18,
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: 2,
}

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
      onClick={() => {
        onChange(!checked)
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'var(--dsw-alias-label-primary-foreground)',
          boxShadow: '0 1px 3px rgba(0, 0, 0, 0.25)',
          transition: 'left 120ms ease',
        }}
      />
    </button>
  )
}

function ProxyModeControl({
  value,
  disabled,
  onChange,
  t,
}: {
  value: OpenAICodexProxyMode
  disabled: boolean
  onChange(value: OpenAICodexProxyMode): void
  t: OpenAICodexSettingsInjected['t']
}) {
  const options: Array<{
    value: OpenAICodexProxyMode
    label: OpenAICodexSettingsKey
  }> = [
    { value: 'off', label: 'proxyModeOff' },
    { value: 'scoped', label: 'proxyModeScoped' },
    { value: 'global', label: 'proxyModeGlobal' },
  ]
  return (
    <div
      style={proxyModeStyle}
      role="radiogroup"
      aria-label={t('proxyMode')}
      onKeyDown={(event) => {
        if (
          event.key !== 'ArrowLeft' &&
          event.key !== 'ArrowRight' &&
          event.key !== 'ArrowUp' &&
          event.key !== 'ArrowDown'
        ) {
          return
        }
        event.preventDefault()
        const currentIndex = options.findIndex((option) => option.value === value)
        const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
        const nextIndex = (currentIndex + direction + options.length) % options.length
        const nextOption = options[nextIndex]
        if (nextOption === undefined) return
        onChange(nextOption.value)
        const buttons = event.currentTarget.querySelectorAll('button')
        buttons.item(nextIndex).focus()
      }}
    >
      {options.map((option, index) => {
        const selected = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            style={{
              ...proxyModeButtonStyle,
              opacity: disabled ? 0.55 : 1,
              ...(index === 0 ? {} : { borderLeft: '1px solid var(--dsw-alias-border-l2)' }),
              ...(selected
                ? {
                    background: 'var(--dsw-alias-button-primary-fill)',
                    color: 'var(--dsw-alias-label-primary-foreground)',
                  }
                : {}),
            }}
            onClick={() => {
              onChange(option.value)
            }}
          >
            {t(option.label)}
          </button>
        )
      })}
    </div>
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

function contextWindowDraft(contextWindow: number | null): string {
  return contextWindow === null ? '' : String(contextWindow / 1_000)
}

function contextWindowTokens(draft: string): number | null | undefined {
  const trimmed = draft.trim()
  if (trimmed.length === 0) return null
  const match = /^(\d+)(?:\.(\d{1,3}))?$/u.exec(trimmed)
  if (match === null) return undefined
  const tokens = Number(match[1]) * 1_000 + Number((match[2] ?? '').padEnd(3, '0'))
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

function formatContextWindow(tokens: number): string {
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(tokens / 1_000)}K`
}

interface ModelCheckboxProps {
  model: ModelCatalogEntry
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  t: NonNullable<OpenAICodexSettingsProps['t']>
}

/** Self-contained model selector card with four explicit fields. */
function ModelCheckbox({ model, checked, disabled, onChange, t }: ModelCheckboxProps) {
  const contextWindow = formatContextWindow(model.contextWindow)
  return (
    <div style={{ ...modelCardStyle, opacity: disabled ? 0.55 : 1 }} role="group" aria-label={model.name}>
      <div style={modelCardHeaderStyle}>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>{t('modelFieldName')}</span>
          <span style={modelNameStyle}>{model.name}</span>
        </span>
        <span style={modelEnableStyle}>
          <span style={modelFieldLabelStyle}>{t('modelFieldEnabled')}</span>
          <PreferenceToggle
            checked={checked}
            disabled={disabled}
            label={t('modelEnableLabel', { name: model.name })}
            onChange={onChange}
          />
        </span>
      </div>
      <div style={modelMetadataStyle}>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>{t('modelFieldId')}</span>
          <span style={modelIdStyle}>{model.id}</span>
        </span>
        <span style={modelFieldStyle}>
          <span style={modelFieldLabelStyle}>{t('modelFieldDefaultWindow')}</span>
          <span style={modelWindowStyle}>{t('modelContextWindowValue', { value: contextWindow })}</span>
        </span>
      </div>
    </div>
  )
}

/** Format a provider-declared Unix-second reset in the user's local timezone. */
export function formatOpenAICodexResetAt(resetAt: number | undefined): string | undefined {
  if (resetAt === undefined || !Number.isSafeInteger(resetAt) || resetAt <= 0) return undefined
  const date = new Date(resetAt * 1_000)
  if (!Number.isFinite(date.getTime())) return undefined
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date)
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

function UsageLimits({
  usage,
  quotaError,
  t,
}: {
  usage: OpenAICodexUsage
  quotaError?: string
  t: OpenAICodexSettingsInjected['t']
}) {
  const hasData = usage.rateLimits.length > 0
  return (
    <div style={quotaListStyle}>
      <h3 style={quotaTitleStyle}>{t('usageLimits')}</h3>
      {usage.rateLimits.map((limit) => (
        <div key={limit.id} style={quotaGroupStyle}>
          <h4 style={quotaTitleStyle}>{limit.name ?? limit.id}</h4>
          {limit.windows.map((window) => (
            <QuotaBar
              key={window.windowSeconds}
              label={windowLabel(window.windowSeconds, t)}
              percent={window.remainingPercent}
              detail={t('resetAt', {
                time: formatOpenAICodexResetAt(window.resetAt) ?? t('resetUnavailable'),
              })}
              t={t}
            />
          ))}
        </div>
      ))}
      {!hasData && quotaError === undefined ? <p style={bodyStyle}>{t('quotaUnavailable')}</p> : null}
      {quotaError === undefined ? null : <p style={errorStyle}>{t('quotaUnavailable')}</p>}
    </div>
  )
}

function dotStyle(status: AccountStatus['status']): CSSProperties {
  const color =
    status === 'signed-in'
      ? 'var(--dsw-alias-state-success-primary, #22a06b)'
      : status === 'error' || status === 'reauth-required' || status === 'remote-web-origin-not-trusted'
        ? 'var(--dsw-alias-state-error-primary, #d92d20)'
        : status === 'signing-in' || status === 'loading'
          ? 'var(--dsw-alias-brand-primary, #1677ff)'
          : 'var(--dsw-alias-label-dimmed, #9aa0a6)'
  return {
    width: 9,
    height: 9,
    borderRadius: '50%',
    flex: '0 0 auto',
    background: color,
  }
}

class AccountRequestError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'AccountRequestError'
  }
}

async function jsonRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    credentials: 'same-origin',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string'
        ? value.error
        : `HTTP ${response.status}`
    throw new AccountRequestError(message)
  }
  return value as T
}

/** OpenAI Codex account status and OAuth actions. */
export function OpenAICodexSettings({ t }: OpenAICodexSettingsProps) {
  if (t === undefined) throw new Error('OpenAI Codex settings requires its translation function')
  const [status, setStatus] = useState<AccountStatus>({ status: 'loading' })
  const [busy, setBusy] = useState(false)
  const [accounts, setAccounts] = useState<AccountsOverview>()
  const [accountsBusy, setAccountsBusy] = useState(false)
  const [accountsError, setAccountsError] = useState<string>()
  const [newAccountName, setNewAccountName] = useState('')
  const [accountName, setAccountName] = useState('')
  const accountId = accounts?.selectedAccountId
  const accountsRequest = useRef(0)
  const accountsUpdating = useRef(false)
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  const accountPath = useCallback((path: string) => accountId === undefined
    ? path : `${path}?accountId=${encodeURIComponent(accountId)}`, [accountId])
  const acceptAccounts = useCallback((value: AccountsOverview) => {
    setAccounts(value)
  }, [])
  const selectedName = accounts?.accounts.find((account) => account.id === accountId)?.name ?? ''
  useEffect(() => { setAccountName(selectedName) }, [accountId, selectedName])
  useEffect(() => {
    let active = true
    const load = () => {
      if (accountsUpdating.current) return
      const request = ++accountsRequest.current
      void jsonRequest<AccountsOverview>(ACCOUNTS_PATH).then((value) => {
        if (active && request === accountsRequest.current) { acceptAccounts(value); setAccountsError(undefined) }
      }, () => { if (active && request === accountsRequest.current) setAccountsError(t('accountsFailed')) })
    }
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    const timer = window.setInterval(load, 10_000)
    return () => { active = false; window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [acceptAccounts, t])
  const updateAccounts = async (patch: object, create = false) => {
    ++accountsRequest.current
    accountsUpdating.current = true
    setAccountsBusy(true)
    setAccountsError(undefined)
    try {
      let value = await jsonRequest<AccountsOverview>(ACCOUNTS_PATH, create ? 'POST' : 'PATCH', patch)
      if (create) {
        const added = value.accounts.find((account) => !accounts?.accounts.some((old) => old.id === account.id))
        if (added) value = await jsonRequest<AccountsOverview>(ACCOUNTS_PATH, 'PATCH', { selectedAccountId: added.id })
        setNewAccountName('')
      }
      acceptAccounts(value)
    } catch { setAccountsError(t('accountsFailed')) }
    finally { accountsUpdating.current = false; setAccountsBusy(false) }
  }
  const [deviceChallenge, setDeviceChallenge] = useState<
    Extract<LoginChallenge, { method: 'device_code' }> | undefined
  >()
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [imageTools, setImageTools] = useState<ImageToolPreferences | undefined>()
  const [imageToolsBusy, setImageToolsBusy] = useState(false)
  const [imageToolsError, setImageToolsError] = useState<string | undefined>()
  const [responseApi, setResponseApi] = useState<ResponseApiPreferences | undefined>()
  const [responseApiBusy, setResponseApiBusy] = useState(false)
  const [responseApiError, setResponseApiError] = useState<string | undefined>()
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogSettings | undefined>()
  const [modelCatalogBusy, setModelCatalogBusy] = useState(false)
  const [modelCatalogError, setModelCatalogError] = useState<string | undefined>()
  const [contextWindow, setContextWindow] = useState<ContextWindowPreferences | undefined>()
  const [contextWindowDraftValue, setContextWindowDraftValue] = useState('')
  const [contextWindowBusy, setContextWindowBusy] = useState(false)
  const [contextWindowError, setContextWindowError] = useState<string | undefined>()
  const [fastMode, setFastMode] = useState<FastModePreferences | undefined>()
  const [fastModeBusy, setFastModeBusy] = useState(false)
  const [fastModeError, setFastModeError] = useState<string | undefined>()
  const [proxy, setProxy] = useState<ProxyPreferences | undefined>()
  const [proxyDraft, setProxyDraft] = useState('')
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [proxySaved, setProxySaved] = useState(false)
  const trustedOriginCommand = `dsh plugin --profile web exec dsh-openai-codex trust-origin ${window.location.origin}`

  const refresh = useCallback(async () => {
    try {
      const next = await jsonRequest<AccountStatus>(accountPath(STATUS_PATH))
      if (accountRef.current !== accountId) return
      setStatus(next)
      if (next.status === 'signed-in') setDeviceChallenge(undefined)
    } catch (error: unknown) {
      if (accountRef.current !== accountId) return
      const message = error instanceof Error ? error.message : t('requestFailed')
      setStatus((current) =>
        current.status === 'signed-in'
          ? { ...current, quotaError: message }
          : error instanceof AccountRequestError && error.code === 'remote-web-origin-not-trusted'
            ? { status: 'remote-web-origin-not-trusted' }
            : { status: 'error', message },
      )
    }
  }, [t, accountPath, accountId])

  useEffect(() => {
    setStatus({ status: 'loading' })
    setDeviceChallenge(undefined)
    setBusy(false)
    let active = true
    void jsonRequest<LocalAccountStatus>(accountPath(LOCAL_STATUS_PATH))
      .then(
        (local) => {
          if (!active) return
          setStatus((current) =>
            current.status !== 'loading'
              ? current
              : local.authenticated
                ? { status: 'signed-in', usage: { rateLimits: [] } }
                : { status: 'signed-out' },
          )
        },
        () => {},
      )
      .finally(() => {
        if (active) void refresh()
      })
    return () => {
      active = false
    }
  }, [refresh, accountPath])
  useEffect(() => {
    void jsonRequest<ImageToolPreferences>(IMAGE_TOOLS_PATH).then(
      (value) => {
        setImageTools(value)
        setImageToolsError(undefined)
      },
      () => {
        setImageToolsError(t('imageToolSettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<ResponseApiPreferences>(RESPONSE_API_PATH).then(
      (value) => {
        setResponseApi(value)
        setResponseApiError(undefined)
      },
      () => {
        setResponseApiError(t('responseApiSettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<ModelCatalogSettings>(MODEL_CATALOG_PATH).then(
      (value) => {
        setModelCatalog(value)
        setModelCatalogError(undefined)
      },
      () => {
        setModelCatalogError(t('modelCatalogSettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<ContextWindowPreferences>(CONTEXT_WINDOW_PATH).then(
      (value) => {
        setContextWindow(value)
        setContextWindowDraftValue(contextWindowDraft(value.contextWindow))
        setContextWindowError(undefined)
      },
      () => {
        setContextWindowError(t('contextWindowSettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<FastModePreferences>(FAST_MODE_SETTINGS_PATH).then(
      (value) => {
        setFastMode(value)
        setFastModeError(undefined)
      },
      () => {
        setFastModeError(t('fastModeSettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    void jsonRequest<ProxyPreferences>(PROXY_PATH).then(
      (value) => {
        setProxy(value)
        setProxyDraft(value.proxyUrl)
        setProxyError(undefined)
      },
      () => {
        setProxyError(t('proxySettingsFailed'))
      },
    )
  }, [t])
  useEffect(() => {
    const interval =
      status.status === 'signing-in'
        ? POLL_INTERVAL_MS
        : status.status === 'signed-in'
          ? USAGE_POLL_INTERVAL_MS
          : undefined
    if (interval === undefined) return
    const timer = window.setInterval(() => {
      void refresh()
    }, interval)
    return () => {
      window.clearInterval(timer)
    }
  }, [refresh, status.status])

  const signIn = async (method: LoginChallenge['method']): Promise<void> => {
    const popup = method === 'browser' ? window.open('about:blank', '_blank') : null
    if (popup !== null) popup.opener = null
    setBusy(true)
    setDeviceChallenge(undefined)
    setStatus({ status: 'signing-in' })
    try {
      const challenge = await jsonRequest<LoginChallenge>(
        accountPath(method === 'browser' ? LOGIN_PATH : DEVICE_LOGIN_PATH),
        'POST',
      )
      if (accountRef.current !== accountId) { popup?.close(); return }
      if (challenge.method !== method) throw new Error('OpenAI Codex returned the wrong sign-in challenge')
      if (challenge.method === 'device_code') {
        setDeviceChallenge(challenge)
        return
      }
      if (popup === null) {
        setStatus({ status: 'error', message: t('popupBlocked') })
        return
      }
      popup.location.replace(challenge.url)
    } catch (error: unknown) {
      popup?.close()
      if (accountRef.current !== accountId) return
      setStatus(
        error instanceof AccountRequestError && error.code === 'remote-web-origin-not-trusted'
          ? { status: 'remote-web-origin-not-trusted' }
          : {
              status: 'error',
              message: error instanceof Error ? error.message : t('requestFailed'),
            },
      )
    } finally {
      if (accountRef.current === accountId) setBusy(false)
    }
  }

  const signOut = async (): Promise<void> => {
    setBusy(true)
    try {
      await jsonRequest<{ ok: true }>(accountPath(LOGOUT_PATH), 'POST')
      if (accountRef.current !== accountId) return
      setDeviceChallenge(undefined)
      setStatus({ status: 'signed-out' })
    } catch (error: unknown) {
      if (accountRef.current !== accountId) return
      setStatus({
        status: 'error',
        message: error instanceof Error ? error.message : t('requestFailed'),
      })
    } finally {
      if (accountRef.current === accountId) setBusy(false)
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

  const updateResponseApi = async (patch: Partial<ResponseApiPreferences>): Promise<void> => {
    setResponseApiBusy(true)
    setResponseApiError(undefined)
    try {
      setResponseApi(await jsonRequest<ResponseApiPreferences>(RESPONSE_API_PATH, 'POST', patch))
    } catch {
      setResponseApiError(t('responseApiSettingsFailed'))
    } finally {
      setResponseApiBusy(false)
    }
  }

  const updateVisibleModel = async (modelId: string, checked: boolean): Promise<void> => {
    if (modelCatalog === undefined) return
    const selected = new Set(modelCatalog.models)
    if (checked) selected.add(modelId)
    else selected.delete(modelId)
    const models = modelCatalog.availableModels
      .filter((model) => selected.has(model.id))
      .map((model) => model.id)
    setModelCatalogBusy(true)
    setModelCatalogError(undefined)
    try {
      setModelCatalog(
        await jsonRequest<ModelCatalogSettings>(MODEL_CATALOG_PATH, 'POST', {
          models,
        }),
      )
    } catch {
      setModelCatalogError(t('modelCatalogSettingsFailed'))
    } finally {
      setModelCatalogBusy(false)
    }
  }

  const updateContextWindow = async (): Promise<void> => {
    const parsed = contextWindowTokens(contextWindowDraftValue)
    if (parsed === undefined) {
      setContextWindowError(t('contextWindowInvalid'))
      return
    }
    setContextWindowBusy(true)
    setContextWindowError(undefined)
    try {
      const saved = await jsonRequest<ContextWindowPreferences>(CONTEXT_WINDOW_PATH, 'POST', {
        contextWindow: parsed,
      })
      setContextWindow(saved)
      setContextWindowDraftValue(contextWindowDraft(saved.contextWindow))
    } catch {
      setContextWindowError(t('contextWindowSettingsFailed'))
    } finally {
      setContextWindowBusy(false)
    }
  }

  const updateSparkContextWindowOverride = async (checked: boolean): Promise<void> => {
    setContextWindowBusy(true)
    setContextWindowError(undefined)
    try {
      setContextWindow(
        await jsonRequest<ContextWindowPreferences>(CONTEXT_WINDOW_PATH, 'POST', {
          overrideSparkContextWindow: checked,
        }),
      )
    } catch {
      setContextWindowError(t('contextWindowSettingsFailed'))
    } finally {
      setContextWindowBusy(false)
    }
  }

  const updateProxy = async (patch: Partial<ProxyPreferences>): Promise<void> => {
    setProxyBusy(true)
    setProxyError(undefined)
    setProxySaved(false)
    try {
      const saved = await jsonRequest<ProxyPreferences>(PROXY_PATH, 'POST', patch)
      setProxy(saved)
      if (patch.proxyUrl !== undefined) setProxyDraft(saved.proxyUrl)
      setProxySaved(true)
    } catch (error: unknown) {
      setProxyError(error instanceof Error ? error.message : t('proxySettingsFailed'))
    } finally {
      setProxyBusy(false)
    }
  }

  const updateFastMode = async (patch: Partial<FastModePreferences>): Promise<void> => {
    setFastModeBusy(true)
    setFastModeError(undefined)
    try {
      setFastMode(await jsonRequest<FastModePreferences>(FAST_MODE_SETTINGS_PATH, 'POST', patch))
    } catch {
      setFastModeError(t('fastModeSettingsFailed'))
    } finally {
      setFastModeBusy(false)
    }
  }

  const copyTrustedOriginCommand = async (): Promise<void> => {
    setCopyFailed(false)
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(trustedOriginCommand)
      setCopied(true)
    } catch {
      setCopyFailed(true)
    }
  }

  const label =
    status.status === 'signed-in'
      ? t('signedIn')
      : status.status === 'loading'
        ? t('loadingAccount')
        : status.status === 'signing-in'
          ? t('signingIn')
          : status.status === 'reauth-required'
            ? t('reauthRequired')
            : status.status === 'remote-web-origin-not-trusted'
              ? t('remoteOriginTitle')
              : status.status === 'error'
                ? t('requestFailed')
                : t('signedOut')

  return (
    <section style={pageStyle} aria-labelledby="openai-codex-settings-title">
      <div>
        <h2 id="openai-codex-settings-title" style={titleStyle}>
          {t('title')}
        </h2>
        <p style={{ ...bodyStyle, marginTop: 6 }}>{t('intro')}</p>
      </div>
      <div style={cardStyle}>
        <h3 style={quotaTitleStyle}>{t('accounts')}</h3>
        <p style={bodyStyle}>{t('accountsHint')}</p>
        <label style={toggleCopyStyle}>
          <span>{t('selectedAccount')}</span>
          <select aria-label={t('selectedAccount')} style={selectStyle} value={accountId ?? ''}
            disabled={accounts === undefined || accountsBusy || busy}
            onChange={(event) => { void updateAccounts({ selectedAccountId: event.currentTarget.value }) }}>
            {accounts?.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
          </select>
        </label>
        <div style={rowStyle}>
          <input aria-label={t('accountName')} style={proxyInputStyle} value={accountName} maxLength={64}
            disabled={accounts === undefined || accountsBusy}
            onChange={(event) => setAccountName(event.currentTarget.value)} />
          <button type="button" style={buttonStyle} disabled={accounts === undefined || accountsBusy || !accountName.trim()}
            onClick={() => { void updateAccounts({ accountId, name: accountName.trim() }) }}>{t('renameAccount')}</button>
        </div>
        <div style={rowStyle}>
          <input aria-label={t('newAccountName')} placeholder={t('newAccountName')} style={proxyInputStyle}
            value={newAccountName} maxLength={64} disabled={accounts === undefined || accountsBusy || busy}
            onChange={(event) => setNewAccountName(event.currentTarget.value)} />
          <button type="button" style={buttonStyle} disabled={accounts === undefined || accountsBusy || busy || !newAccountName.trim()}
            onClick={() => { void updateAccounts({ name: newAccountName.trim() }, true) }}>{t('addAccount')}</button>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}><span style={statusStyle}>{t('autoSwitchAccounts')}</span>
            <span style={bodyStyle}>{t('autoSwitchAccountsHint')}</span></span>
          <PreferenceToggle label={t('autoSwitchAccounts')} checked={accounts?.autoSwitch ?? false}
            disabled={accounts === undefined || accountsBusy}
            onChange={(autoSwitch) => { void updateAccounts({ autoSwitch }) }} />
        </div>
        {accountsError === undefined ? null : <p style={errorStyle} role="alert">{accountsError}</p>}
      </div>
      <div style={cardStyle}>
        <div style={rowStyle}>
          <div style={statusStyle} role="status">
            <span aria-hidden="true" style={dotStyle(status.status)} />
            <span>{label}</span>
          </div>
          {status.status === 'loading' ||
          status.status === 'remote-web-origin-not-trusted' ? null : status.status === 'signed-in' ? (
            <button
              type="button"
              style={buttonStyle}
              disabled={busy}
              onClick={() => {
                void signOut()
              }}
            >
              {busy ? t('working') : t('logout')}
            </button>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                type="button"
                style={primaryButtonStyle}
                disabled={busy}
                onClick={() => {
                  void signIn('device_code')
                }}
              >
                {busy ? t('working') : t('loginDeviceCode')}
              </button>
              <button
                type="button"
                style={buttonStyle}
                disabled={busy}
                onClick={() => {
                  void signIn('browser')
                }}
              >
                {t('loginBrowser')}
              </button>
            </div>
          )}
        </div>
        {status.status === 'error' || status.status === 'reauth-required' ? (
          <p style={errorStyle}>{status.message}</p>
        ) : null}
        {deviceChallenge === undefined ? null : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={bodyStyle}>{t('deviceCodeInstructions')}</p>
            <code style={deviceCodeStyle}>{deviceChallenge.code}</code>
            <a
              href={deviceChallenge.url}
              target="_blank"
              rel="noreferrer"
              style={{ ...buttonStyle, alignSelf: 'flex-start', textDecoration: 'none' }}
            >
              {t('openDeviceCodePage')}
            </a>
          </div>
        )}
        {status.status === 'remote-web-origin-not-trusted' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <p style={errorStyle}>{t('remoteOriginDescription')}</p>
            <p style={bodyStyle}>{t('remoteOriginCommandHelp')}</p>
            <code style={commandStyle}>{trustedOriginCommand}</code>
            <div style={rowStyle}>
              <button
                type="button"
                style={buttonStyle}
                onClick={() => {
                  void copyTrustedOriginCommand()
                }}
              >
                {copied ? t('remoteOriginCopied') : t('remoteOriginCopy')}
              </button>
              {copyFailed ? <span style={errorStyle}>{t('remoteOriginCopyFailed')}</span> : null}
            </div>
          </div>
        ) : null}
        {status.status === 'signed-in' ? (
          <UsageLimits
            usage={status.usage}
            {...(status.quotaError === undefined ? {} : { quotaError: status.quotaError })}
            t={t}
          />
        ) : null}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('proxy')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('proxyIntro')}</p>
        </div>
        <ProxyModeControl
          value={proxy?.proxyMode ?? 'off'}
          disabled={proxy === undefined || proxyBusy}
          onChange={(proxyMode) => {
            void updateProxy({ proxyMode })
          }}
          t={t}
        />
        <p style={bodyStyle}>
          {t(
            proxy?.proxyMode === 'scoped'
              ? 'proxyModeScopedHint'
              : proxy?.proxyMode === 'global'
                ? 'proxyModeGlobalHint'
                : 'proxyModeOffHint',
          )}
        </p>
        <div style={{ ...rowStyle, justifyContent: 'flex-start' }}>
          <label htmlFor="openai-codex-proxy-url" style={statusStyle}>
            {t('proxyUrl')}
          </label>
          <input
            id="openai-codex-proxy-url"
            type="url"
            inputMode="url"
            spellCheck={false}
            placeholder={t('proxyUrlPlaceholder')}
            value={proxyDraft}
            disabled={proxy === undefined || proxyBusy}
            style={proxyInputStyle}
            onChange={(event) => {
              setProxyDraft(event.currentTarget.value)
              setProxySaved(false)
            }}
          />
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={proxy === undefined || proxyBusy}
            onClick={() => {
              void updateProxy({ proxyUrl: proxyDraft })
            }}
          >
            {proxyBusy ? t('working') : t('proxySave')}
          </button>
        </div>
        <p style={bodyStyle}>{t('proxyUrlHint')}</p>
        {proxyError === undefined ? null : <p style={errorStyle}>{proxyError}</p>}
        {proxySaved ? <p style={bodyStyle}>{t('proxySaved')}</p> : null}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('modelCatalog')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('modelCatalogIntro')}</p>
        </div>
        <div style={modelListStyle} role="group" aria-label={t('modelCatalog')}>
          {modelCatalog?.availableModels.map((model) => (
            <ModelCheckbox
              key={model.id}
              model={model}
              checked={modelCatalog.models.includes(model.id)}
              disabled={modelCatalogBusy}
              onChange={(checked) => {
                void updateVisibleModel(model.id, checked)
              }}
              t={t}
            />
          ))}
        </div>
        {modelCatalogError === undefined ? null : <p style={errorStyle}>{modelCatalogError}</p>}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('contextWindow')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('contextWindowIntro')}</p>
        </div>
        <div style={{ ...rowStyle, justifyContent: 'flex-start' }}>
          <label htmlFor="openai-codex-context-window" style={statusStyle}>
            {t('contextWindowInput')}
          </label>
          <input
            id="openai-codex-context-window"
            type="number"
            inputMode="decimal"
            min="0.001"
            step="0.001"
            placeholder={t('contextWindowPlaceholder')}
            value={contextWindowDraftValue}
            disabled={contextWindow === undefined || contextWindowBusy}
            style={numberInputStyle}
            onChange={(event) => {
              setContextWindowDraftValue(event.currentTarget.value)
            }}
          />
          <button
            type="button"
            style={primaryButtonStyle}
            disabled={contextWindow === undefined || contextWindowBusy}
            onClick={() => {
              void updateContextWindow()
            }}
          >
            {contextWindowBusy ? t('working') : t('contextWindowSave')}
          </button>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('overrideSparkContextWindow')}</span>
            <span style={bodyStyle}>{t('overrideSparkContextWindowHint')}</span>
          </span>
          <PreferenceToggle
            label={t('overrideSparkContextWindow')}
            disabled={contextWindow === undefined || contextWindowBusy}
            checked={contextWindow?.overrideSparkContextWindow ?? false}
            onChange={(checked) => {
              void updateSparkContextWindowOverride(checked)
            }}
          />
        </div>
        <p style={bodyStyle}>{t('contextWindowHint')}</p>
        {contextWindowError === undefined ? null : <p style={errorStyle}>{contextWindowError}</p>}
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
            onChange={(checked) => {
              void updateImageTool({ modifyReadImage: checked })
            }}
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
            onChange={(checked) => {
              void updateImageTool({ shareImagegenWithOtherModels: checked })
            }}
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
          <label htmlFor="openai-codex-reasoning-summary" style={toggleCopyStyle}>
            <span style={statusStyle}>{t('reasoningSummary')}</span>
            <span style={bodyStyle}>{t('reasoningSummaryHint')}</span>
          </label>
          <select
            id="openai-codex-reasoning-summary"
            aria-label={t('reasoningSummary')}
            disabled={responseApi === undefined || responseApiBusy}
            value={responseApi?.reasoningSummary ?? 'auto'}
            style={{ ...selectStyle, opacity: responseApi === undefined || responseApiBusy ? 0.55 : 1 }}
            onChange={(event) => {
              void updateResponseApi({
                reasoningSummary: event.currentTarget.value as ResponseApiPreferences['reasoningSummary'],
              })
            }}
          >
            <option value="auto">{t('reasoningSummaryAuto')}</option>
            <option value="concise">{t('reasoningSummaryConcise')}</option>
            <option value="detailed">{t('reasoningSummaryDetailed')}</option>
          </select>
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
            onChange={(checked) => {
              void updateResponseApi({ useWebSocketContextReuse: checked })
            }}
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
            onChange={(checked) => {
              void updateResponseApi({ useNativeCompaction: checked })
            }}
          />
        </div>
        {responseApiError === undefined ? null : <p style={errorStyle}>{responseApiError}</p>}
      </div>
      <div style={cardStyle}>
        <div>
          <h3 style={quotaTitleStyle}>{t('fastMode')}</h3>
          <p style={{ ...bodyStyle, marginTop: 5 }}>{t('fastModeIntro')}</p>
        </div>
        <div style={toggleRowStyle}>
          <span style={toggleCopyStyle}>
            <span style={statusStyle}>{t('fastModeDefault')}</span>
            <span style={bodyStyle}>{t('fastModeDefaultHint')}</span>
          </span>
          <PreferenceToggle
            label={t('fastModeDefault')}
            disabled={fastMode === undefined || fastModeBusy}
            checked={fastMode?.fastModeDefault ?? false}
            onChange={(checked) => {
              void updateFastMode({ fastModeDefault: checked })
            }}
          />
        </div>
        {fastModeError === undefined ? null : <p style={errorStyle}>{fastModeError}</p>}
      </div>
    </section>
  )
}
