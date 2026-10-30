/** Configurable Codex quota indicators for the Composer tool row. */

import { useEffect, useId, useSyncExternalStore, useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { OpenAICodexUsage, OpenAICodexRateLimitWindow } from '../usage.ts'
import { OPENAI_CODEX_AUTH_STATUS_PATH, OPENAI_CODEX_COMPOSER_QUOTA_PATH } from '../auth-paths.ts'
import type { ComposerQuotaPreferences } from '../tool-policy.ts'
import { formatOpenAICodexResetAt } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsKey } from './locales.ts'

const WEEK_SECONDS = 7 * 24 * 60 * 60
const USAGE_POLL_INTERVAL_MS = 60_000
const CODEX_PROVIDER = 'openai-codex'

type Translate = (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string

export interface OpenAICodexQuotaIndicatorInjected {
  /** Session-scoped model directory shared with the model selection surface. */
  readonly directory: SnapshotStore<ModelDirectoryState>
}

interface UsageRequestState {
  readonly status: 'loading' | 'hidden' | 'ready'
  readonly usage?: OpenAICodexUsage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWindow(value: unknown): value is OpenAICodexRateLimitWindow {
  if (!isRecord(value)) return false
  const remainingPercent = value['remainingPercent']
  const windowSeconds = value['windowSeconds']
  const resetAt = value['resetAt']
  return typeof remainingPercent === 'number'
    && Number.isFinite(remainingPercent)
    && remainingPercent >= 0
    && remainingPercent <= 100
    && typeof windowSeconds === 'number'
    && Number.isSafeInteger(windowSeconds)
    && windowSeconds > 0
    && (resetAt === undefined || (typeof resetAt === 'number'
      && Number.isSafeInteger(resetAt)
      && resetAt > 0
      && Number.isFinite(new Date(resetAt * 1_000).getTime())))
}

function usageFromStatus(value: unknown): OpenAICodexUsage | undefined {
  if (!isRecord(value) || value['status'] !== 'signed-in') return undefined
  const usage = value['usage']
  if (!isRecord(usage) || !Array.isArray(usage['rateLimits'])) return undefined
  const rateLimits = usage['rateLimits']
  for (const limit of rateLimits) {
    if (!isRecord(limit) || typeof limit['id'] !== 'string' || !Array.isArray(limit['windows'])) return undefined
    if (!limit['windows'].every(isWindow)) return undefined
  }
  return usage as unknown as OpenAICodexUsage
}

function quotaOf(usage: OpenAICodexUsage, seconds: number): OpenAICodexRateLimitWindow | undefined {
  return usage.rateLimits.find(limit => limit.id === 'codex')?.windows.find(window => window.windowSeconds === seconds)
}

// All mounted eligible composers share one request and timer.
const usageListeners = new Set<(state: UsageRequestState) => void>()
let sharedUsage: UsageRequestState = { status: 'loading' }
let stopPolling: (() => void) | undefined
function subscribeUsage(listener: (state: UsageRequestState) => void): () => void {
  usageListeners.add(listener)
  if (stopPolling === undefined) {
    const controller = new AbortController()
    let inFlight = false
    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const response = await fetch(OPENAI_CODEX_AUTH_STATUS_PATH, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' }, signal: controller.signal })
        const value: unknown = await response.json().catch(() => undefined)
        const usage = response.ok ? usageFromStatus(value) : undefined
        if (!controller.signal.aborted) sharedUsage = usage === undefined ? { status: 'hidden' } : { status: 'ready', usage }
      } catch {
        if (!controller.signal.aborted) sharedUsage = { status: 'hidden' }
      } finally {
        inFlight = false
        if (!controller.signal.aborted) for (const notify of usageListeners) notify(sharedUsage)
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, USAGE_POLL_INTERVAL_MS)
    stopPolling = () => { window.clearInterval(timer); controller.abort(); sharedUsage = { status: 'loading' }; stopPolling = undefined }
  }
  listener(sharedUsage)
  return () => { usageListeners.delete(listener); if (usageListeners.size === 0) stopPolling?.() }
}

function isGptModel(state: ModelDirectoryState): boolean {
  const current = state.current
  return state.status === 'ready'
    && current?.provider === CODEX_PROVIDER
    && typeof current.model === 'string'
    && current.model.toLowerCase().startsWith('gpt-')
}

function formatPercent(percent: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(percent)
}

const QUOTA_PROGRESS_WIDTH_PX = 48
const QUOTA_PROGRESS_TRACK_HEIGHT_PX = 6

type QuotaProgressColor = 'green' | 'yellow' | 'orange' | 'red'

function boundedQuotaPercent(remainingPercent: number): number {
  return Math.min(100, Math.max(0, remainingPercent))
}

function quotaProgressColor(remainingPercent: number): {
  readonly name: QuotaProgressColor
  readonly value: string
} {
  const bounded = boundedQuotaPercent(remainingPercent)
  if (bounded >= 60) {
    return { name: 'green', value: 'var(--dsw-alias-state-success-primary, #22c55e)' }
  }
  if (bounded >= 40) {
    return { name: 'yellow', value: 'var(--dsw-alias-state-warn-primary, #eab308)' }
  }
  if (bounded >= 20) {
    return { name: 'orange', value: '#f97316' }
  }
  return { name: 'red', value: 'var(--dsw-alias-state-error-primary, #ef4444)' }
}

function subscribeDirectory(directory: SnapshotStore<ModelDirectoryState>, listener: () => void): () => void {
  return directory.subscribe(listener)
}

/** Render nothing until an eligible GPT Codex session has a usable weekly quota. */
export function OpenAICodexQuotaIndicator({ directory, t }: OpenAICodexQuotaIndicatorInjected & { t: Translate }) {
  const directoryState = useSyncExternalStore(
    listener => subscribeDirectory(directory, listener),
    () => directory.getSnapshot(),
    () => directory.getSnapshot(),
  )
  const eligible = isGptModel(directoryState)
  const [request, setRequest] = useState<UsageRequestState>({ status: 'loading' })
  const [choice, setChoice] = useState<ComposerQuotaPreferences['composerQuota']>('weekly')
  useEffect(() => {
    if (!eligible) return
    return subscribeUsage(setRequest)
  }, [eligible])
  useEffect(() => {
    if (!eligible) return
    let disposed = false
    const refreshChoice = () => {
      void fetch(OPENAI_CODEX_COMPOSER_QUOTA_PATH, { credentials: 'same-origin' })
        .then(response => response.ok ? response.json() : undefined)
        .then((value: unknown) => {
          if (!disposed && isRecord(value) && (value['composerQuota'] === 'weekly' || value['composerQuota'] === 'five-hour' || value['composerQuota'] === 'both')) setChoice(value['composerQuota'])
        }).catch(() => undefined)
    }
    refreshChoice()
    window.addEventListener('dsh-codex-composer-quota-changed', refreshChoice)
    return () => { disposed = true; window.removeEventListener('dsh-codex-composer-quota-changed', refreshChoice) }
  }, [eligible])
  if (!eligible || request.status !== 'ready' || request.usage === undefined) return null
  const windows = [
    ...(choice === 'five-hour' || choice === 'both' ? [{ kind: 'five-hour' as const, window: quotaOf(request.usage, 5 * 60 * 60) }] : []),
    ...(choice === 'weekly' || choice === 'both' ? [{ kind: 'weekly' as const, window: quotaOf(request.usage, WEEK_SECONDS) }] : []),
  ]
  return <span style={{ display: 'inline-flex', gap: '8px' }}>{windows.map(({ kind, window }) => window === undefined ? null : <QuotaWindow key={kind} kind={kind} quota={window} t={t} />)}</span>
}

function QuotaWindow({ kind, quota, t }: { kind: 'five-hour' | 'weekly'; quota: OpenAICodexRateLimitWindow; t: Translate }) {
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const tooltipId = useId()
  const percent = formatPercent(quota.remainingPercent)
  const fullResetTime = formatOpenAICodexResetAt(quota.resetAt)
  const summary = fullResetTime === undefined
    ? t(kind === 'weekly' ? 'composerWeeklyQuotaNoReset' : 'composerFiveHourQuotaNoReset', { percent })
    : t(kind === 'weekly' ? 'composerWeeklyQuotaSummary' : 'composerFiveHourQuotaSummary', { percent, time: fullResetTime })
  const boundedPercent = boundedQuotaPercent(quota.remainingPercent)
  const progressColor = quotaProgressColor(quota.remainingPercent)
  const tooltipVisible = isHovered || isFocused
  return (
    <span
      role="status"
      data-openai-codex-quota={kind}
      aria-label={summary}
      aria-describedby={tooltipVisible ? tooltipId : undefined}
      tabIndex={0}
      onMouseEnter={() => { setIsHovered(true) }}
      onMouseLeave={() => { setIsHovered(false) }}
      onFocus={() => { setIsFocused(true) }}
      onBlur={() => { setIsFocused(false) }}
      style={{
        display: 'inline-flex',
        gap: '4px',
        height: '28px',
        position: 'relative',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>{t(kind === 'weekly' ? 'composerQuotaWeekly' : 'composerQuotaFiveHour')}</span>
      <span
        aria-hidden="true"
        data-openai-codex-quota-track={kind}
        style={{
          display: 'block',
          width: `${QUOTA_PROGRESS_WIDTH_PX}px`,
          height: `${QUOTA_PROGRESS_TRACK_HEIGHT_PX}px`,
          borderRadius: '999px',
          backgroundColor: 'var(--dsw-alias-border-l2)',
          overflow: 'hidden',
        }}
      >
        <span
          aria-hidden="true"
          data-openai-codex-quota-progress={kind}
          data-openai-codex-quota-color={progressColor.name}
          style={{
            display: 'block',
            width: `${boundedPercent}%`,
            height: '100%',
            borderRadius: 'inherit',
            backgroundColor: progressColor.value,
          }}
        />
      </span>
      {tooltipVisible ? (
        <span
          id={tooltipId}
          role="tooltip"
          data-openai-codex-quota-tooltip={kind}
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            padding: '4px 8px',
            borderRadius: '6px',
            backgroundColor: 'var(--dsw-specific-tip, #1f2329)',
            color: 'var(--dsw-alias-label-primary, #ffffff)',
            boxShadow: 'var(--dsw-shadow-lv2, 0 4px 12px rgb(0 0 0 / 12%))',
            fontSize: '12px',
            lineHeight: '18px',
          }}
        >{summary}</span>
      ) : null}
    </span>
  )
}
