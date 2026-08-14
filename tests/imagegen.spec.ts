import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { CallId, createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal

let workspace: string
let dshHome: string
let context: Context | undefined
let callCounter = 0

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-imagegen-'))
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-imagegen-home-'))
  vi.stubEnv('DSH_HOME', dshHome)
  const store = new OpenAICodex.OpenAICodexCredentialStore()
  await store.modify(OpenAICodex.OPENAI_CODEX_PROVIDER, () => Promise.resolve({
    type: 'oauth',
    access: accessToken('image-account'),
    refresh: 'refresh-secret',
    expires: Date.now() + 3_600_000,
    accountId: 'image-account',
  }))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  await rm(workspace, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

async function setup(
  config: OpenAICodex.Config = {},
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access',
): Promise<Context> {
  const ctx = new Context()
  context = ctx
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  if (sandboxMode === undefined) {
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
  } else {
    await ctx.plugin(SandboxPolicyService, { mode: sandboxMode, workspaceRoot: workspace })
    await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  }
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(WebRuntime)
  await ctx.plugin(OpenAICodex, config)
  return ctx
}

function agent(
  messages: readonly Message[] = [],
  model = 'gpt-5.6-sol',
  provider = OpenAICodex.OPENAI_CODEX_PROVIDER,
): object {
  return {
    options: {},
    session: {
      id: 'imagegen-session',
      events: [],
      header: { cwd: workspace },
      deriveMessages: () => messages,
      requestHeader: () => ({ config: { provider, model } }),
      append: () => undefined,
    },
  }
}

async function generate(
  ctx: Context,
  args: Record<string, unknown>,
  messages: readonly Message[] = [],
  model = 'gpt-5.6-sol',
  provider = OpenAICodex.OPENAI_CODEX_PROVIDER,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`imagegen-${++callCounter}`),
    name: OpenAICodex.IMAGEGEN_TOOL_NAME,
    arguments: args,
    agent: agent(messages, model, provider) as never,
  })
}

function successfulFetch() {
  return vi.fn(async () => new Response(JSON.stringify({
    data: [{ b64_json: PNG_1X1.toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('imagegen', () => {
  it('generates an attachment and optionally publishes the same PNG to the workspace', async () => {
    const ctx = await setup()
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny red pixel', output_path: 'art/pixel.png' })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('<output_path operation="create">')
    expect(await readFile(join(workspace, 'art', 'pixel.png'))).toEqual(PNG_1X1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OpenAICodex.OPENAI_CODEX_IMAGE_GENERATIONS_URL)
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${accessToken('image-account')}`)
    expect(headers.get('chatgpt-account-id')).toBe('image-account')
    expect(headers.get('x-codex-image-turn-id')).toBeNull()
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: 'A tiny red pixel',
      background: 'auto',
      model: 'gpt-image-2',
      quality: 'auto',
      size: 'auto',
    })
  })

  it('saves under a unique workspace filename when output_path is omitted', async () => {
    const ctx = await setup()
    vi.stubGlobal('fetch', successfulFetch())

    const result = await generate(ctx, { prompt: 'A tiny red pixel' })

    expect(result.isError).toBe(false)
    const text = result.content.find(block => block.type === 'text')?.text ?? ''
    const match = text.match(/<output_path operation="create">([^<]+)<\/output_path>/u)
    expect(basename(match?.[1] ?? '')).toMatch(/^generated-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}\.png$/u)
    expect(await readFile(match?.[1] ?? 'missing')).toEqual(PNG_1X1)
  })

  it('reads reference paths through ctx.fs and sends data URLs only inside the provider request', async () => {
    const ctx = await setup()
    await writeFile(join(workspace, 'reference.png'), PNG_1X1)
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Keep the composition and change the color',
      referenced_image_paths: ['reference.png'],
    })

    expect(result.isError).toBe(false)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OpenAICodex.OPENAI_CODEX_IMAGE_EDITS_URL)
    const body = JSON.parse(init.body as string) as { images: Array<{ image_url: string }> }
    expect(body.images).toEqual([{ image_url: `data:image/png;base64,${PNG_1X1.toString('base64')}` }])
  })

  it('can use recent conversation image attachments without model-supplied bytes', async () => {
    const ctx = await setup()
    const ref = await ctx.attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png', name: 'prior.png' })
    const messages = [createUserMessage({
      content: [{ type: 'image', attachment: ref }],
      source: { kind: 'user' },
    })]
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Make a variation',
      num_last_images_to_include: 1,
    }, messages)

    expect(result.isError).toBe(false)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { images: Array<{ image_url: string }> }
    expect(body.images[0]?.image_url).toBe(`data:image/png;base64,${PNG_1X1.toString('base64')}`)
  })

  it('rejects ambiguous reference selection before making a provider request', async () => {
    const ctx = await setup()
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, {
      prompt: 'Edit this',
      referenced_image_paths: ['one.png'],
      num_last_images_to_include: 1,
    })

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('provide only one')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a text-only caller before generated image bytes enter its history', async () => {
    const ctx = await setup()
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny pixel' }, [], 'gpt-5.3-codex-spark')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('does not declare image input')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the setting that disables imagegen for another model provider', async () => {
    const ctx = await setup({ shareImagegenWithOtherModels: false })
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)

    const result = await generate(ctx, { prompt: 'A tiny pixel' }, [], 'vision-model', 'another-provider')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('disabled for models outside')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the attachment but refuses output_path under a read-only filesystem policy', async () => {
    const ctx = await setup({}, 'read-only')
    vi.stubGlobal('fetch', successfulFetch())

    const result = await generate(ctx, { prompt: 'A tiny pixel', output_path: 'blocked.png' })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('read-only mode')
    await expect(readFile(join(workspace, 'blocked.png'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
