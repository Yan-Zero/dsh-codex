import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal

let workspace: string
let dshHome: string
let ctx: Context | undefined
let callCounter = 0

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-view-image-'))
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-view-image-home-'))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx?.fiber.dispose()
  ctx = undefined
  await rm(workspace, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

async function setup(config: OpenAICodex.Config = {}): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime, { mode: 'native' })
  await context.plugin(LocalFileSystem, { cwd: workspace })
  await context.plugin(LocalAttachmentStore, { dshHome })
  await context.plugin(LlmRuntime)
  await context.plugin(WebRuntime)
  await context.plugin(OpenAICodex, config)
  return context
}

function agentOn(model: string, provider = OpenAICodex.OPENAI_CODEX_PROVIDER): object {
  return {
    options: {},
    session: {
      header: { cwd: workspace },
      requestHeader: () => ({ config: { provider, model } }),
      append: () => undefined,
    },
  }
}

async function view(
  context: Context,
  source: string,
  model = 'gpt-5.6-sol',
  provider = OpenAICodex.OPENAI_CODEX_PROVIDER,
) {
  return context.tools.execute({
    signal,
    callId: CallId(`view-image-${++callCounter}`),
    name: OpenAICodex.VIEW_IMAGE_TOOL_NAME,
    arguments: { source },
    agent: agentOn(model, provider) as never,
  })
}

describe('view_image', () => {
  it('returns a durable image block for a local path', async () => {
    const context = await setup()
    await writeFile(join(workspace, 'pixel.bin'), PNG_1X1)

    const result = await view(context, 'pixel.bin')

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text' && block.text.includes('image/png'))).toBeDefined()
  })

  it('follows an HTTP image URL and checks the received bytes', async () => {
    const context = await setup()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })))

    const result = await view(context, 'https://images.example/pixel')

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('refuses a model that does not explicitly declare image input', async () => {
    const context = await setup()
    await writeFile(join(workspace, 'pixel.png'), PNG_1X1)

    const result = await view(context, 'pixel.png', 'gpt-5.3-codex-spark')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('does not declare image input')
  })

  it('honors the setting that disables view_image for another model provider', async () => {
    const context = await setup({ shareViewImageWithOtherModels: false })
    await writeFile(join(workspace, 'pixel.png'), PNG_1X1)

    const result = await view(context, 'pixel.png', 'vision-model', 'another-provider')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('disabled for models outside')
  })
})
