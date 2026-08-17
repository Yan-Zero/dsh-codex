import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import type { CodexRuntimeAvailability } from './standard-runtime.ts'

export interface OpenAICodexSettingsGateInjected extends OpenAICodexSettingsInjected {
  loadAvailability(): Promise<CodexRuntimeAvailability>
}

export type OpenAICodexSettingsGateProps = Partial<OpenAICodexSettingsGateInjected>

const pageStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 720 }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: '28px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }
const bodyStyle: CSSProperties = { margin: 0, fontSize: 14, lineHeight: '22px', color: 'var(--dsw-alias-label-secondary)' }
const errorStyle: CSSProperties = { ...bodyStyle, color: 'var(--dsw-alias-state-error-primary)' }

/** Prevent a locally installed browser contribution from impersonating an absent Runtime plugin. */
export function OpenAICodexSettingsGate({ t, loadAvailability }: OpenAICodexSettingsGateProps) {
  if (t === undefined || loadAvailability === undefined) throw new Error('OpenAI Codex Runtime gate is missing dependencies')
  const [availability, setAvailability] = useState<CodexRuntimeAvailability | undefined>()

  useEffect(() => {
    let active = true
    void loadAvailability().then(
      value => { if (active) setAvailability(value) },
      (error: unknown) => {
        if (active) setAvailability({ state: 'unavailable', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { active = false }
  }, [loadAvailability])

  if (availability?.state === 'installed') return <OpenAICodexSettings t={t} />
  return (
    <section style={pageStyle} aria-labelledby="openai-codex-settings-title">
      <h2 id="openai-codex-settings-title" style={titleStyle}>{t('title')}</h2>
      {availability === undefined
        ? <p style={bodyStyle}>{t('checkingRuntime')}</p>
        : availability.state === 'not-installed'
          ? <p style={bodyStyle}>{t('notInstalled', { runtime: availability.runtime })}</p>
          : <p style={errorStyle}>{t('runtimeUnavailable', { message: availability.message })}</p>}
    </section>
  )
}
