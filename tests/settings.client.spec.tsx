/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OpenAICodexSettings } from '../src/client/OpenAICodexSettings.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenAICodexSettingsKey } from '../src/client/locales.ts'

const responses: Record<string, unknown> = {
  '/plugins/dsh-openai-codex/auth/status': { status: 'signed-out' },
  '/plugins/dsh-openai-codex/image-tools': {
    modifyReadImage: true,
    shareImagegenWithOtherModels: true,
  },
  '/plugins/dsh-openai-codex/response-api': {
    useWebSocketContextReuse: false,
    useNativeCompaction: false,
  },
  '/plugins/dsh-openai-codex/custom-context': {
    customContext: 'Initial context',
    customContextKind: 'application',
  },
  '/plugins/dsh-openai-codex/models': {
    availableModels: [],
    models: [],
  },
}

function translate(key: OpenAICodexSettingsKey, params?: Record<string, unknown>): string {
  let value = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) {
    value = value.replace(`{${name}}`, String(replacement))
  }
  return value
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('OpenAI Codex custom context settings', () => {
  it('loads, edits, and saves the context text and trust level', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      if (path === '/plugins/dsh-openai-codex/custom-context' && init?.method === 'POST') {
        return jsonResponse(JSON.parse(String(init.body)))
      }
      return jsonResponse(responses[path])
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<OpenAICodexSettings t={translate} />)

    const textarea = await screen.findByRole('textbox', { name: en.customContextValue })
    expect((textarea as HTMLTextAreaElement).value).toBe('Initial context')
    fireEvent.change(textarea, { target: { value: 'Workspace uses pnpm.' } })
    fireEvent.change(screen.getByRole('combobox', { name: en.customContextKind }), {
      target: { value: 'untrusted' },
    })
    fireEvent.click(screen.getByRole('button', { name: en.customContextSave }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/dsh-openai-codex/custom-context',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            customContext: 'Workspace uses pnpm.',
            customContextKind: 'untrusted',
          }),
        }),
      )
    })
  })
})
