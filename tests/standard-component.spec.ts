import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { CommandHandler } from '@dsh-std/command'
import { parseManifest } from '@dsh-std/manifest'
import { createOpenAICodexFacet } from '../src/standard.ts'
import type { OpenAICodexService } from '../src/service.ts'
import packageJson from '../package.json' with { type: 'json' }

function service(): OpenAICodexService {
  return {
    credentials: {} as never,
    authStatus: async () => ({ authenticated: true }),
    models: () => [{ id: 'gpt-test', name: 'GPT Test' }],
    usage: async () => ({ rateLimits: [] }),
    login: async () => undefined,
    logout: async () => undefined,
    imagePreferences: () => ({ modifyReadImage: true, shareImagegenWithOtherModels: true }),
    responsePreferences: () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
    updateImagePreferences: async () => ({ modifyReadImage: true, shareImagegenWithOtherModels: true }),
    updateResponsePreferences: async () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
  } as unknown as OpenAICodexService
}

describe('standard component boundary', () => {
  it('declares a portable facet module with executable model and command handlers', async () => {
    const manifest = parseManifest(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
    expect(manifest.manifestVersion).toBe('0.15')
    expect(manifest.version).toBe(packageJson.version)
    expect(manifest.facets.host).toEqual({ entry: 'lib/standard.js', apiVersion: 'v1alpha1' })
    expect(manifest.requires.contracts).toContainEqual({ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' })
    expect(manifest.requires.contracts).toContainEqual({
      apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal', optional: true,
      fallback: 'use device-code authentication',
    })
    expect(manifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ai.openai.codex.command.codex' }),
    ]))
    const published = new Map<string, unknown>()
    const facet = createOpenAICodexFacet(service())
    await facet.activate({
      extensions: { publish(reference: { kind: string }, name: string, handler: unknown) { published.set(`${reference.kind}:${name}`, handler); return () => undefined } },
      scope: { signal: new AbortController().signal, add: (dispose: () => void | Promise<void>) => dispose },
    } as never)
    expect(published.get('ModelProvider:openai-codex')).toMatchObject({ listModels: expect.any(Function), stream: expect.any(Function) })
    const command = published.get('Command:codex') as CommandHandler
    await expect(command.execute({ rawInput: 'config' }, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: 'success' })
  })

  it('uses the invocation-scoped OpenExternal client for browser login', async () => {
    const candidate = service()
    candidate.authStatus = async () => ({ authenticated: false })
    candidate.login = async interaction => {
      expect(await interaction.prompt({
        type: 'select', message: 'Choose login method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      })).toBe('browser')
      interaction.notify({ type: 'auth_url', url: 'https://example.test/authorize' })
    }
    const published = new Map<string, unknown>()
    const facet = createOpenAICodexFacet(candidate)
    await facet.activate({
      extensions: { publish(reference: { kind: string }, name: string, handler: unknown) { published.set(`${reference.kind}:${name}`, handler); return () => undefined } },
      scope: { signal: new AbortController().signal, add: (dispose: () => void | Promise<void>) => dispose },
    } as never)
    const openExternal = vi.fn(async () => ({ status: 'submitted' as const, value: { accepted: true as const } }))
    const command = published.get('Command:codex') as CommandHandler
    await expect(command.execute({ rawInput: 'login' }, {
      signal: new AbortController().signal,
      presentation: {
        descriptor: {
          clientId: 'tui-1',
          contracts: [{ apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal' }],
        },
        openExternal: { openExternal },
      },
    })).resolves.toEqual({
      kind: 'success', text: 'Opened the ChatGPT authorization page. Use /codex status after approval.',
    })
    expect(openExternal).toHaveBeenCalledWith(
      { uri: 'https://example.test/authorize' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
