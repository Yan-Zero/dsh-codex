import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { CallId, LlmRuntime } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as OpenAICodex from '../src/index.ts'
import { enhancedReadImageTool } from '../src/read-image-enhancement.ts'
import type { PublicHttpRuntime } from '../src/public-http.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const signal = new AbortController().signal

let workspace: string
let dshHome: string
let ctx: Context | undefined
let callCounter = 0
let delegatedPaths: string[]

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-read-image-'))
  dshHome = await mkdtemp(join(tmpdir(), 'dsh-openai-codex-read-image-home-'))
  delegatedPaths = []
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx?.fiber.dispose()
  ctx = undefined
  await rm(workspace, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

function baseReadImage(context: Context) {
  return defineTool({
    name: 'read_image',
    description: 'Read an image from a local file path.',
    parameters: {
      file_path: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          image: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
        },
      },
      render: () => [],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      delegatedPaths.push(args.file_path)
      const ref = await context.attachments.saveImage({ data: PNG_1X1, mediaType: 'image/png', name: 'local.png' })
      return {
        path: args.file_path,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
    },
  })
}

async function setup(publicHttpRuntime?: PublicHttpRuntime): Promise<Context> {
  const context = new Context()
  ctx = context
  await context.plugin(SystemPrompt)
  await context.plugin(ToolRuntime, { mode: 'native' })
  await context.plugin(LocalFileSystem, { cwd: workspace })
  await context.plugin(LocalAttachmentStore, { dshHome })
  await context.plugin(LlmRuntime)
  await context.plugin(WebRuntime)
  await context.plugin(OpenAICodex)
  context.tools.register(enhancedReadImageTool(context, baseReadImage(context), publicHttpRuntime))
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

async function readImage(
  context: Context,
  arguments_: { file_path?: string; url?: string },
  model = 'gpt-5.6-sol',
) {
  return context.tools.execute({
    signal,
    callId: CallId(`read-image-${++callCounter}`),
    name: OpenAICodex.READ_IMAGE_TOOL_NAME,
    arguments: arguments_,
    agent: agentOn(model) as never,
  })
}

describe('read_image enhancement', () => {
  it('advertises separate local-path and HTTP(S) URL inputs', async () => {
    const context = await setup()
    const schema = context.tools.schemas().find(tool => tool.name === 'read_image')

    expect(schema?.description).toContain('HTTP(S) URL')
    expect(schema?.parameters).toMatchObject({
      properties: {
        file_path: { type: 'string' },
        url: { type: 'string' },
      },
    })
    expect(context.tools.get('view_image')).toBeUndefined()
  })

  it('delegates local paths to Harness read_image', async () => {
    const context = await setup()

    const result = await readImage(context, { file_path: 'pixel.png' })

    expect(result.isError).toBe(false)
    expect(delegatedPaths).toEqual(['pixel.png'])
    expect(result.content.some(block => block.type === 'image')).toBe(true)
  })

  it('downloads an HTTP image and checks the received bytes', async () => {
    const get = vi.fn(async () => ({ status: 200, data: new Uint8Array(PNG_1X1) }))
    const context = await setup({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      get,
    })

    const result = await readImage(context, { url: 'https://images.example/pixel' })

    expect(result.isError).toBe(false)
    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(delegatedPaths).toEqual([])
    expect(get).toHaveBeenCalledOnce()
  })

  it('requires exactly one input source', async () => {
    const context = await setup()

    const missing = await readImage(context, {})
    const ambiguous = await readImage(context, { file_path: 'pixel.png', url: 'https://images.example/pixel' })

    expect(missing.isError).toBe(true)
    expect(ambiguous.isError).toBe(true)
    expect(missing.content.find(block => block.type === 'text')?.text).toContain('exactly one')
  })

  it('refuses a URL result for a model without declared image input', async () => {
    const context = await setup()

    const result = await readImage(context, { url: 'https://images.example/pixel' }, 'gpt-5.3-codex-spark')

    expect(result.isError).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('does not declare image input')
  })
})
