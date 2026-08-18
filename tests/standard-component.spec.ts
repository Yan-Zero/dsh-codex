import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { extensionDefinition as commandExtensionDefinition } from '@dsh-std/command'
import type { CommandHandler } from '@dsh-std/command'
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import { extensionDefinition as toolExtensionDefinition, overrideExtensionDefinition } from '@dsh-std/tool'
import { eventExtensionDefinition } from '@dsh-std/session'
import { OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT } from '../src/search-event.ts'
import { createOpenAICodexFacet } from '../src/standard-factory.ts'
import { OPENAI_CODEX_TUI_SCENE, TUI_API_VERSION, TUI_SCENE_KIND } from '../src/tui.ts'
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
    updateImagePreferences: async () => ({ modifyReadImage: true, shareImagegenWithOtherModels: true }),
    responsePreferences: () => ({ useWebSocketContextReuse: false, useNativeCompaction: false }),
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
      fallback: 'show the browser-login URL or use device-code authentication',
    })
    expect(manifest.requires.contracts).toContainEqual({
      apiVersion: 'presentation.dsh/v1alpha1', kind: 'ExternalRedirect', optional: true,
      fallback: 'use the agent-local callback listener or device-code authentication',
    })
    expect(manifest.contributes.commands).toEqual([])
    const commandResource = projectManifest(manifest).spec.facets[0]?.extensions?.find(extension =>
      extension.apiVersion === 'commands.dsh/v1alpha1' && extension.kind === 'Command'
      && extension.metadata.name === 'codex')
    expect(() => commandExtensionDefinition.validateSpec(commandResource?.spec)).not.toThrow()
    const extensions = projectManifest(manifest).spec.facets[0]?.extensions ?? []
    const imagegenResource = extensions.find(extension => extension.kind === 'Tool' && extension.metadata.name === 'imagegen')
    const readImageResource = extensions.find(extension => extension.kind === 'ToolOverride'
      && extension.metadata.name === 'openai-codex-read-image')
    const searchResource = extensions.find(extension => extension.kind === 'ToolOverride'
      && extension.metadata.name === 'openai-codex-web-search')
    expect(() => toolExtensionDefinition.validateSpec(imagegenResource?.spec)).not.toThrow()
    expect(() => overrideExtensionDefinition.validateSpec(readImageResource?.spec)).not.toThrow()
    expect(() => overrideExtensionDefinition.validateSpec(searchResource?.spec)).not.toThrow()
    expect(searchResource?.spec).toMatchObject({
      target: 'web_search', providers: ['openai-codex'], executionOnly: true,
    })
    const legacySearchEvent = extensions.find(extension => extension.kind === 'SessionEvent'
      && extension.metadata.name === OPENAI_CODEX_SEARCH_MODEL_REQUEST_EVENT)
    expect(() => eventExtensionDefinition.validateSpec(legacySearchEvent?.spec)).not.toThrow()
    expect(legacySearchEvent?.spec).toMatchObject({ replay: 'required' })
    const tuiScene = extensions.find(extension => extension.apiVersion === TUI_API_VERSION
      && extension.kind === TUI_SCENE_KIND && extension.metadata.name === OPENAI_CODEX_TUI_SCENE)
    expect(tuiScene?.spec).toEqual({
      title: 'OpenAI Codex', titles: { en: 'OpenAI Codex', zh: 'OpenAI Codex' },
    })
    expect(commandResource?.spec).toMatchObject({
      children: expect.arrayContaining([
        expect.objectContaining({ name: 'login', spec: expect.objectContaining({
          arguments: [expect.objectContaining({ values: expect.arrayContaining([
            expect.objectContaining({ value: 'browser' }), expect.objectContaining({ value: 'device' }),
          ]) })],
        }) }),
        expect.objectContaining({ name: 'set', spec: expect.objectContaining({
          arguments: [
            expect.objectContaining({ values: expect.arrayContaining([
              expect.objectContaining({ value: 'websocket-context' }),
              expect.objectContaining({ value: 'native-compaction' }),
              expect.objectContaining({ value: 'read-image' }),
              expect.objectContaining({ value: 'imagegen-other-models' }),
            ]) }),
            expect.objectContaining({ values: [
              expect.objectContaining({ value: 'on' }), expect.objectContaining({ value: 'off' }),
            ] }),
          ],
        }) }),
      ]),
    })
    const published = new Map<string, unknown>()
    const facet = createOpenAICodexFacet(service())
    await facet.activate({
      extensions: { publish(reference: { kind: string }, name: string, handler: unknown) { published.set(`${reference.kind}:${name}`, handler); return () => undefined } },
      scope: { signal: new AbortController().signal, add: (dispose: () => void | Promise<void>) => dispose },
    } as never)
    expect(published.get('ModelProvider:openai-codex')).toMatchObject({ listModels: expect.any(Function), stream: expect.any(Function) })
    expect(published.get('Tool:imagegen')).toMatchObject({ resolve: expect.any(Function) })
    expect(published.get('ToolOverride:openai-codex-read-image')).toMatchObject({ resolve: expect.any(Function) })
    expect(published.get('ToolOverride:openai-codex-web-search')).toMatchObject({ resolve: expect.any(Function) })
    expect(published.get(`${TUI_SCENE_KIND}:${OPENAI_CODEX_TUI_SCENE}`)).toMatchObject({
      component: expect.any(Function),
    })
    const command = published.get('Command:codex') as CommandHandler
    await expect(command.execute({ rawInput: 'config' }, {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: 'success' })
  })

  it('defaults to device-code login even when OpenExternal is available', async () => {
    const candidate = service()
    candidate.authStatus = async () => ({ authenticated: false })
    candidate.login = async interaction => {
      expect(await interaction.prompt({
        type: 'select', message: 'Choose login method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      })).toBe('device_code')
      interaction.notify({
        type: 'device_code', verificationUri: 'https://example.test/device', userCode: 'ABCD-EFGH',
        expiresInSeconds: 900, intervalSeconds: 5,
      })
    }
    const facet = createOpenAICodexFacet(candidate)
    let command: CommandHandler | undefined
    await facet.activate({
      extensions: { publish(reference: { kind: string }, _name: string, handler: unknown) {
        if (reference.kind === 'Command') command = handler as CommandHandler
        return () => undefined
      } },
      scope: { signal: new AbortController().signal, add: (dispose: () => void | Promise<void>) => dispose },
    } as never)
    const openExternal = vi.fn()
    await expect(command!.execute({ rawInput: 'login' }, {
      signal: new AbortController().signal,
      presentation: { descriptor: { clientId: 'tui-1', contracts: [] }, openExternal: { openExternal } },
    })).resolves.toEqual({
      kind: 'success', text: 'Open https://example.test/device\nEnter code: ABCD-EFGH\nUse /codex status after approval.',
    })
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('routes the exact browser callback through invocation-scoped presentation clients', async () => {
    const candidate = service()
    candidate.authStatus = async () => ({ authenticated: false })
    candidate.login = async interaction => {
      expect(await interaction.prompt({
        type: 'select', message: 'Choose login method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      })).toBe('browser')
      interaction.notify({ type: 'auth_url', url: 'https://example.test/authorize' })
      await expect(interaction.prompt({
        type: 'manual_code', message: 'Complete login', placeholder: 'http://localhost:1455/auth/callback',
      })).resolves.toBe('http://localhost:1455/auth/callback?code=secret-code&state=expected-state')
    }
    const published = new Map<string, unknown>()
    const facet = createOpenAICodexFacet(candidate)
    await facet.activate({
      extensions: { publish(reference: { kind: string }, name: string, handler: unknown) { published.set(`${reference.kind}:${name}`, handler); return () => undefined } },
      scope: { signal: new AbortController().signal, add: (dispose: () => void | Promise<void>) => dispose },
    } as never)
    const openExternal = vi.fn(async () => ({ status: 'submitted' as const, value: { accepted: true as const } }))
    const receive = vi.fn(() => ({
      invocationId: 'redirect-1',
      ready: Promise.resolve({ type: 'ready' as const, redirectUri: 'http://localhost:1455/auth/callback' }),
      result: Promise.resolve({
        status: 'submitted' as const,
        value: { query: { code: ['secret-code'], state: ['expected-state'] } },
      }),
      cancel() {},
    }))
    const command = published.get('Command:codex') as CommandHandler
    await expect(command.execute({ rawInput: 'login browser' }, {
      signal: new AbortController().signal,
      presentation: {
        descriptor: {
          clientId: 'tui-1',
          contracts: [
            { apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal' },
            { apiVersion: 'presentation.dsh/v1alpha1', kind: 'ExternalRedirect' },
          ],
        },
        openExternal: { openExternal },
        externalRedirect: { receive },
      },
    })).resolves.toEqual({
      kind: 'success', text: 'OpenAI Codex sign-in complete.',
    })
    expect(openExternal).toHaveBeenCalledWith(
      { uri: 'https://example.test/authorize' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(receive).toHaveBeenCalledWith(
      { exactRedirectUri: 'http://localhost:1455/auth/callback' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })
})
