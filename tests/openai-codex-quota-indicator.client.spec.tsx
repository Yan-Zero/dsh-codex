// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { formatOpenAICodexResetAt } from '../src/client/OpenAICodexSettings.tsx'
import { OpenAICodexQuotaIndicator } from '../src/client/OpenAICodexQuotaIndicator.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenAICodexSettingsKey } from '../src/client/locales.ts'

function t(key: OpenAICodexSettingsKey, params: Record<string, unknown> = {}): string {
  return Object.entries(params).reduce(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    en[key],
  )
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function directoryState(model: string, provider = 'openai-codex'): ModelDirectoryState {
  return {
    current: { provider, model },
    routable: true,
    groups: [],
    failures: [],
    pending: null,
    status: 'ready',
    error: null,
  }
}

function usage(resetAt?: number, remainingPercent = 72.5): unknown {
  return {
    rateLimits: [{
      id: 'codex',
      name: 'Codex',
      windows: [{
        remainingPercent,
        windowSeconds: 7 * 24 * 60 * 60,
        ...resetAt === undefined ? {} : { resetAt },
      }],
    }],
  }
}

function directoryStore(state: ModelDirectoryState): SnapshotStore<ModelDirectoryState> {
  const listeners = new Set<() => void>()
  let snapshot = state
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update: () => undefined,
    set: next => {
      snapshot = next
      listeners.forEach(listener => { listener() })
    },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenAI Codex Composer quota preference', () => {
  it.each([
    ['five-hour', ['five-hour']],
    ['weekly', ['weekly']],
    ['both', ['five-hour', 'weekly']],
  ] as const)('shows the selected %s window(s) with their own labels and reset times', async (choice, expected) => {
    const fiveHourReset = 1_735_689_600
    const weeklyReset = 1_736_294_400
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/composer-quota')
        ? json({ composerQuota: choice })
        : json({ status: 'signed-in', usage: { rateLimits: [{ id: 'codex', windows: [
          { remainingPercent: 23, windowSeconds: 5 * 60 * 60, resetAt: fiveHourReset },
          { remainingPercent: 72.5, windowSeconds: 7 * 24 * 60 * 60, resetAt: weeklyReset },
        ] }] } })))
    const directory = directoryStore(directoryState('gpt-5'))
    const { container } = render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)

    await waitFor(() => {
      for (const window of ['five-hour', 'weekly'] as const) {
        const progress = container.querySelector<HTMLElement>(`[data-openai-codex-quota-progress="${window}"]`)
        if (expected.includes(window as never)) {
          expect(progress?.style.width).toBe(window === 'five-hour' ? '23%' : '72.5%')
        } else expect(progress).toBeNull()
      }
    })
    const indicators = screen.getAllByRole('status')
    const labels = indicators.map(indicator => indicator.getAttribute('aria-label') ?? '').join(' ')
    for (const window of expected) {
      expect(labels).toContain(window === 'five-hour' ? '23%' : '72.5%')
      expect(labels).toMatch(window === 'five-hour' ? /5.hour|five.hour/i : /weekly/i)
      expect(labels).toContain(formatOpenAICodexResetAt(window === 'five-hour' ? fiveHourReset : weeklyReset))
    }
    for (const indicator of indicators) {
      fireEvent.mouseEnter(indicator)
      const tooltip = await screen.findByRole('tooltip')
      expect(tooltip.textContent).toBe(indicator.getAttribute('aria-label'))
      fireEvent.mouseLeave(indicator)
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull())
    }
  })

  it('shows an available window when both are selected but one is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) =>
      String(input).endsWith('/composer-quota')
        ? json({ composerQuota: 'both' })
        : json({ status: 'signed-in', usage: usage() })))
    const directory = directoryStore(directoryState('gpt-5'))
    const { container } = render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    await waitFor(() => expect(container.querySelector('[data-openai-codex-quota-progress="weekly"]')).not.toBeNull())
    expect(container.querySelector('[data-openai-codex-quota-progress="five-hour"]')).toBeNull()
  })
})

describe('OpenAI Codex Composer weekly quota', () => {
  it('shows only for a GPT model on the exact OpenAI Codex provider', async () => {
    const resetAt = 1_735_689_600
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: usage(resetAt) }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5-codex'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    const indicator = await screen.findByRole('status')
    const localReset = formatOpenAICodexResetAt(resetAt)
    expect(indicator.textContent).toBe(en.composerQuotaWeekly)
    expect(indicator.querySelector('svg[data-openai-codex-quota-ring="weekly"]')).toBeNull()
    const track = indicator.querySelector<HTMLElement>('[data-openai-codex-quota-track="weekly"]')
    expect(track?.style.width).toBe('48px')
    expect(track?.style.height).toBe('6px')
    const progress = indicator.querySelector<HTMLElement>('[data-openai-codex-quota-progress="weekly"]')
    expect(progress?.style.width).toBe('72.5%')
    expect(progress?.getAttribute('data-openai-codex-quota-color')).toBe('green')
    expect(indicator.textContent).not.toContain(en.composerWeeklyQuota)
    expect(indicator.textContent).not.toContain(localReset)
    expect(indicator.hasAttribute('title')).toBe(false)
    expect(indicator.getAttribute('aria-label')).toContain(en.composerWeeklyQuota)
    expect(indicator.getAttribute('aria-label')).toContain('72.5%')
    expect(indicator.getAttribute('aria-label')).toContain(localReset)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shows a visible tooltip on hover and keyboard focus', async () => {
    const resetAt = 1_735_689_600
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: usage(resetAt) }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5-codex'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    const indicator = await screen.findByRole('status')
    const localReset = formatOpenAICodexResetAt(resetAt)
    expect(screen.queryByRole('tooltip')).toBeNull()

    fireEvent.mouseEnter(indicator)
    const hoverTooltip = await screen.findByRole('tooltip')
    expect(hoverTooltip.textContent).toContain('72.5%')
    expect(hoverTooltip.textContent).toContain(localReset)
    fireEvent.mouseLeave(indicator)
    await waitFor(() => { expect(screen.queryByRole('tooltip')).toBeNull() })

    fireEvent.focus(indicator)
    const focusTooltip = await screen.findByRole('tooltip')
    expect(focusTooltip.textContent).toContain('72.5%')
    expect(focusTooltip.textContent).toContain(localReset)
    fireEvent.blur(indicator)
    await waitFor(() => { expect(screen.queryByRole('tooltip')).toBeNull() })
  })

  it.each([
    [80, 'green'],
    [50, 'yellow'],
    [35, 'orange'],
    [10, 'red'],
  ] as const)('maps %s%% remaining quota to the %s progress color', async (remainingPercent, color) => {
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: usage(undefined, remainingPercent) }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    const indicator = await screen.findByRole('status')
    const progress = indicator.querySelector<HTMLElement>('[data-openai-codex-quota-progress="weekly"]')
    expect(progress?.style.width).toBe(`${remainingPercent}%`)
    expect(progress?.getAttribute('data-openai-codex-quota-color')).toBe(color)
  })

  it.each([
    ['non-GPT model', directoryState('o3')],
    ['wrong provider', directoryState('gpt-5', 'openai')],
  ])('hides for a %s', async (_label, state) => {
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: usage() }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(state)

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the indicator visible with an explicit unavailable reset time', async () => {
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: usage() }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    const indicator = await screen.findByRole('status')
    expect(indicator.textContent).not.toContain(en.resetUnavailable)
    expect(indicator.getAttribute('aria-label')?.toLowerCase()).toContain(en.resetUnavailable.toLowerCase())
  })

  it('hides on signed-out or failed quota requests', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('request failed') })
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    await waitFor(() => { expect(screen.queryByRole('status')).toBeNull() })
  })

  it('hides when the signed-in response has no codex weekly window', async () => {
    const fetchMock = vi.fn(async () => json({ status: 'signed-in', usage: { rateLimits: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5'))

    render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('aborts an in-flight status request when the entry unmounts', async () => {
    let signal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (String(_input).endsWith('/auth/status')) signal = init?.signal instanceof AbortSignal ? init.signal : undefined
      return new Promise<Response>(() => {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const directory = directoryStore(directoryState('gpt-5'))

    const rendered = render(<OpenAICodexQuotaIndicator directory={directory} t={t} />)
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
