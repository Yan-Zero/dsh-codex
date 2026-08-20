// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAICodexSettings } from '../src/client/OpenAICodexSettings.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenAICodexSettingsKey } from '../src/client/locales.ts'

function t(key: OpenAICodexSettingsKey): string {
  return en[key]
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenAI Codex settings model catalog', () => {
  it('renders checkboxes and persists the provider-ordered visible subset', async () => {
    const availableModels = [
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    ]
    let selected = availableModels.map(model => model.id)
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const path = String(input)
      if (path.endsWith('/auth/status')) return json({ status: 'signed-out' })
      if (path.endsWith('/image-tools')) return json({ modifyReadImage: true, shareImagegenWithOtherModels: true })
      if (path.endsWith('/response-api')) return json({ useWebSocketContextReuse: false, useNativeCompaction: false })
      if (path.endsWith('/models')) {
        if (init?.method === 'POST') selected = (JSON.parse(String(init.body)) as { models: string[] }).models
        return json({ availableModels, models: selected })
      }
      throw new Error(`unexpected settings request: ${path}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={t} />)
    const luna = await screen.findByRole<HTMLInputElement>('checkbox', { name: /GPT-5\.6 Luna/u })
    const sol = screen.getByRole<HTMLInputElement>('checkbox', { name: /GPT-5\.6 Sol/u })
    expect(luna.checked).toBe(true)
    expect(sol.checked).toBe(true)

    fireEvent.click(luna)
    await waitFor(() => { expect(luna.checked).toBe(false) })
    const modelPost = fetchMock.mock.calls.find(([input, init]) => String(input).endsWith('/models') && init?.method === 'POST')
    expect(modelPost).toBeDefined()
    expect(JSON.parse(String(modelPost?.[1]?.body))).toEqual({ models: ['gpt-5.6-sol'] })
  })
})
