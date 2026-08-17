import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import type { CommandHandler } from '@dsh-std/command'
import { parseManifest } from '@dsh-std/manifest'
import type { OpenAICodexService } from '../src/service.ts'
import * as TuiAdapter from '../src/tui.ts'
import standardFacet, { createOpenAICodexFacet } from '../src/standard.ts'
import packageJson from '../package.json' with { type: 'json' }

const standardManifest = parseManifest(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'))
let context: Context | undefined
const facetCleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const dispose of facetCleanup.splice(0).reverse()) await dispose()
  await context?.fiber.dispose()
  context = undefined
})

function fakeService(): OpenAICodexService {
  let imagePreferences = { modifyReadImage: true, shareImagegenWithOtherModels: true }
  let responsePreferences = { useWebSocketContextReuse: false, useNativeCompaction: false }
  return {
    authStatus: vi.fn(async () => ({ authenticated: true, expiresAt: new Date('2026-08-17T00:00:00Z') })),
    models: vi.fn(() => [{ id: 'gpt-test', name: 'GPT Test' }]),
    usage: vi.fn(async () => ({
      rateLimits: [{ id: 'codex', name: 'Codex', windows: [{ windowSeconds: 18_000, remainingPercent: 62.5 }] }],
    })),
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    imagePreferences: vi.fn(() => ({ ...imagePreferences })),
    updateImagePreferences: vi.fn(async patch => {
      imagePreferences = { ...imagePreferences, ...patch }
      return { ...imagePreferences }
    }),
    responsePreferences: vi.fn(() => ({ ...responsePreferences })),
    updateResponsePreferences: vi.fn(async patch => {
      responsePreferences = { ...responsePreferences, ...patch }
      return { ...responsePreferences }
    }),
  } as unknown as OpenAICodexService
}

async function activateStandard(facet = standardFacet): Promise<{ command: CommandHandler; published: string[] }> {
  let command: CommandHandler | undefined
  const published: string[] = []
  await facet.activate({
    extensions: {
      publish(reference: { apiVersion: string; kind: string }, name: string, handler: unknown) {
        published.push(`${reference.apiVersion} ${reference.kind} ${name}`)
        if (reference.kind === 'Command') command = handler as CommandHandler
        return () => undefined
      },
    },
    scope: {
      add(dispose: () => void | Promise<void>) {
        facetCleanup.push(dispose)
        return dispose
      },
    },
  } as never)
  if (command === undefined) throw new Error('standard facet did not publish the Codex command')
  return { command, published }
}

const invocation = {
  signal: new AbortController().signal,
  present: () => false,
}

describe('standard command with optional dsh-tui completion', () => {
  it('keeps the v0.15 manifest aligned with the package and portable lifecycle', () => {
    expect(standardManifest.version).toBe(packageJson.version)
    expect(standardManifest.facets.host).toEqual({ entry: 'lib/standard.js', apiVersion: 'v1alpha1' })
    expect(standardManifest.contributes.commands).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ai.openai.codex.command.codex' }),
    ]))
  })

  it('keeps the TUI subpath optional and limited to completion metadata', async () => {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(TuiAdapter)
    expect(ctx.get('openAICodexTui')).toBeUndefined()

    let tree: { children(path: readonly string[]): readonly { name: string }[] } | undefined
    ctx.provide('tuiCommandTrees', {
      register(provider: typeof tree & { root: string }) { tree = provider; return () => { tree = undefined } },
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    if (tree === undefined) throw new Error('Codex completion tree was not registered')
    expect(tree.children(['codex']).map(row => row.name)).toEqual(['status', 'login', 'logout', 'usage', 'config', 'set'])
    expect(tree.children(['codex', 'login']).map(row => row.name)).toEqual(['browser', 'device'])
  })

  it('publishes and executes the command through the standard handler', async () => {
    const service = fakeService()
    const { command, published } = await activateStandard(createOpenAICodexFacet(service))
    expect(published).toEqual(expect.arrayContaining([
      'commands.dsh/v1alpha1 Command codex',
      'models.dsh/v1alpha1 ModelProvider openai-codex',
    ]))
    await expect(command.execute({ rawInput: ' status' }, invocation)).resolves.toEqual({
      kind: 'success',
      text: 'OpenAI Codex is signed in. Access token expires 2026-08-17T00:00:00.000Z; refresh is automatic.',
    })
    await expect(command.execute({ rawInput: ' set native-compaction on' }, invocation)).resolves.toMatchObject({
      kind: 'success', text: expect.stringContaining('native-compaction: on'),
    })
    expect(service.updateResponsePreferences).toHaveBeenCalledWith({ useNativeCompaction: true })
  })

  it('uses device login when the negotiated presentation cannot open a browser', async () => {
    const service = fakeService()
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: false })
    let selected: string | undefined
    vi.mocked(service.login).mockImplementation(async interaction => {
      selected = await interaction.prompt({
        type: 'select', message: 'Choose login method',
        options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device' }],
      })
      await interaction.notify({
        type: 'device_code', verificationUri: 'https://example.test/device', userCode: 'ABCD-EFGH',
      })
    })
    const { command } = await activateStandard(createOpenAICodexFacet(service))
    await expect(command.execute({ rawInput: ' login' }, {
      ...invocation,
      presentation: { clientId: 'tui-1', contracts: [] },
    })).resolves.toEqual({
      kind: 'success',
      text: 'Open https://example.test/device\nEnter code: ABCD-EFGH\nUse /codex status after approval.',
    })
    expect(selected).toBe('device_code')
  })

  it('projects provider authentication state without an adapter-specific snapshot type', async () => {
    const service = fakeService()
    vi.mocked(service.authStatus).mockResolvedValue({ authenticated: false })
    const facet = createOpenAICodexFacet(service)
    await expect(facet.snapshot?.()).resolves.toMatchObject({
      extensions: [{
        apiVersion: 'models.dsh/v1alpha1', kind: 'ModelProvider', name: 'openai-codex',
        status: { state: 'authentication-required' },
      }],
    })
  })
})
