import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutableToolDefinition, ToolExecutionContext } from '@dsh-std/tool'
import { enhancedReadImageTool } from '../src/read-image.ts'
import { ImageToolPolicy } from '../src/preferences.ts'

const PNG_1X1 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const signal = new AbortController().signal

let delegatedPaths: string[]

beforeEach(() => {
  delegatedPaths = []
})

afterEach(() => { vi.unstubAllGlobals() })

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    signal,
    model: { provider: 'openai-codex', model: 'gpt-test', inputModalities: ['text', 'image'] },
    saveImage: vi.fn(async () => ({
      reference: { attachmentId: 'image-1' }, mediaType: 'image/png', bytes: PNG_1X1.byteLength,
      width: 1, height: 1, name: 'test.png',
    })),
    recentImages: vi.fn(), readWorkspaceFile: vi.fn(), writeWorkspaceFile: vi.fn(),
    imageLimits: {
      maxImageBytes: 64, maxImagesPerMessage: 5, maxMessageImageBytes: 32,
      maxImagePixels: 4096, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    validateImage: vi.fn(async () => undefined),
    deferContent: vi.fn(),
    delegate: vi.fn(async input => {
      const path = input['file_path'] as string
      delegatedPaths.push(path)
      return {
        data: { path },
        content: [{ type: 'image' as const, reference: { attachmentId: 'local-image' } }],
      }
    }),
    ...overrides,
  }
}

function baseReadImage(): ExecutableToolDefinition {
  return {
    name: 'read_image',
    description: 'Read an image from a local file path.',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } } },
    output: {},
    isConcurrencySafe: () => true,
    execute: async args => {
      delegatedPaths.push(args['file_path'] as string)
      return { data: { path: args['file_path'] ?? '' }, content: [] }
    },
  }
}

function enhancedReadImage() {
  return enhancedReadImageTool(new ImageToolPolicy()).resolve(baseReadImage())!
}

async function readImage(
  definition: ExecutableToolDefinition,
  arguments_: { file_path?: string; url?: string },
  model = 'gpt-5.6-sol',
) {
  try {
    const result = await definition.execute(arguments_, context({
      model: { provider: 'openai-codex', model, inputModalities: model === 'gpt-5.3-codex-spark' ? ['text'] : ['text', 'image'] },
    }))
    return { ...result, isError: false as const }
  } catch (error: unknown) {
    return {
      data: {},
      isError: true as const,
      content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
    }
  }
}

describe('read_image enhancement', () => {
  it('advertises separate local-path and HTTP(S) URL inputs', () => {
    const definition = enhancedReadImage()

    expect(definition.description).toContain('HTTP(S) URL')
    expect(definition.parameters).toMatchObject({
      properties: {
        file_path: { type: 'string' },
        url: { type: 'string' },
      },
    })
  })

  it('delegates workspace paths to the original tool', async () => {
    const definition = enhancedReadImage()
    const result = await readImage(definition, { file_path: 'pixel.png' })

    expect(result.isError).toBe(false)
    expect(result.data).toMatchObject({ path: 'pixel.png' })
    expect(delegatedPaths).toEqual(['pixel.png'])
    expect(result.content.some(block => block.type === 'image')).toBe(true)
  })

  it('downloads an HTTP image and checks the received bytes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })))
    const definition = enhancedReadImage()
    const execution = context()
    const result = await definition.execute({ url: 'https://images.example/pixel' }, execution)

    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.data).toMatchObject({ path: 'https://images.example/pixel', image: { mediaType: 'image/png' } })
    expect(result.data).toMatchObject({ image: { attachmentId: 'image-1' } })
    expect(execution.saveImage).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'image/png', data: PNG_1X1 }))
    expect(result.content).toContainEqual({ type: 'image', reference: { attachmentId: 'image-1' } })
    expect(execution.deferContent).toHaveBeenCalledWith(result.content)
    expect(delegatedPaths).toEqual([])
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects URL credentials and redirects outside HTTP(S)', async () => {
    const definition = enhancedReadImage()
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'file:///private/image.png' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(definition.execute({ url: 'https://user:secret@images.example/pixel' }, context()))
      .rejects.toThrow('must not contain credentials')
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(definition.execute({ url: 'https://images.example/redirect' }, context()))
      .rejects.toThrow('redirected outside http(s)')
  })

  it('enforces the smaller message byte limit before reading the body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, {
      status: 200, headers: { 'content-length': '33' },
    })))

    await expect(enhancedReadImage().execute({ url: 'https://images.example/large' }, context()))
      .rejects.toThrow('exceeds 32 bytes')
  })

  it('honors deployment media-type restrictions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(PNG_1X1, { status: 200 })))
    const execution = context({
      imageLimits: {
        maxImageBytes: 64, maxImagesPerMessage: 5, maxMessageImageBytes: 32,
        maxImagePixels: 4096, mediaTypes: ['image/jpeg'],
      },
    })

    await expect(enhancedReadImage().execute({ url: 'https://images.example/pixel' }, execution))
      .rejects.toThrow('image/png images are disabled')
    expect(execution.saveImage).not.toHaveBeenCalled()
  })

  it('requires exactly one input source', async () => {
    const definition = enhancedReadImage()
    const missing = await readImage(definition, {})
    const ambiguous = await readImage(definition, { file_path: 'pixel.png', url: 'https://images.example/pixel' })

    expect(missing.isError).toBe(true)
    expect(ambiguous.isError).toBe(true)
    expect((missing.content.find(block => block.type === 'text') as { text?: string } | undefined)?.text).toContain('exactly one')
  })

  it('refuses a URL result for a model without declared image input', async () => {
    const definition = enhancedReadImage()
    const result = await readImage(definition, { url: 'https://images.example/pixel' }, 'gpt-5.3-codex-spark')

    expect(result.isError).toBe(true)
    expect((result.content.find(block => block.type === 'text') as { text?: string } | undefined)?.text).toContain('does not declare image input')
  })

  it('disables the live override through standard preferences', () => {
    const policy = new ImageToolPolicy({ modifyReadImage: false })
    expect(enhancedReadImageTool(policy).resolve(baseReadImage())).toBeUndefined()
  })
})
