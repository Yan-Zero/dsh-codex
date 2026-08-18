import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionContext } from '@dsh-std/tool'
import {
  imagegenTool,
  OPENAI_CODEX_IMAGE_EDITS_URL,
  OPENAI_CODEX_IMAGE_GENERATIONS_URL,
} from '../src/imagegen.ts'
import { ImageToolPolicy } from '../src/preferences.ts'

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

afterEach(() => { vi.unstubAllGlobals() })

function accessToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`
}

function credentials(access = accessToken('image-account')): never {
  return {
    read: vi.fn(async () => ({
      type: 'oauth', access, refresh: 'refresh-secret', expires: Date.now() + 3_600_000,
      accountId: 'image-account',
    })),
    list: vi.fn(async () => []),
    modify: vi.fn(),
    delete: vi.fn(),
  } as never
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    model: { provider: 'openai-codex', model: 'gpt-5.6-sol', inputModalities: ['text', 'image'] },
    imageLimits: {
      maxImageBytes: 20 * 1024 * 1024,
      maxImagesPerMessage: 5,
      maxMessageImageBytes: 20 * 1024 * 1024,
      maxImagePixels: 16_000_000,
      mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    },
    validateImage: vi.fn(async () => undefined),
    saveImage: vi.fn(async image => ({
      reference: { attachmentId: 'generated-1' },
      mediaType: image.mediaType,
      bytes: image.data.byteLength,
      width: 1,
      height: 1,
      ...(image.name === undefined ? {} : { name: image.name }),
    })),
    recentImages: vi.fn(async () => []),
    readWorkspaceFile: vi.fn(),
    writeWorkspaceFile: vi.fn(async (path, data) => ({ path, operation: 'create' as const, bytes: data.byteLength })),
    deferContent: vi.fn(),
    ...overrides,
  }
}

function successfulFetch() {
  return vi.fn(async () => new Response(JSON.stringify({
    data: [{ b64_json: PNG_1X1.toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('imagegen', () => {
  it('generates an attachment and optionally publishes the same PNG to the workspace', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const execution = context()
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    const result = await tool.execute({ prompt: 'A tiny red pixel', output_path: 'art/pixel.png' }, execution)

    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('<output_path operation="create">')
    expect(execution.saveImage).toHaveBeenCalledWith({ data: PNG_1X1, mediaType: 'image/png', name: 'generated.png' })
    expect(execution.writeWorkspaceFile).toHaveBeenCalledWith('art/pixel.png', PNG_1X1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENAI_CODEX_IMAGE_GENERATIONS_URL)
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
    vi.stubGlobal('fetch', successfulFetch())
    const writeWorkspaceFile = vi.fn(async (path: string, data: Uint8Array) => ({
      path, operation: 'create' as const, bytes: data.byteLength,
    }))
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    await tool.execute({ prompt: 'A tiny red pixel' }, context({ writeWorkspaceFile }))

    expect(writeWorkspaceFile.mock.calls[0]?.[0]).toMatch(
      /^generated-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-[0-9a-f]{8}\.png$/u,
    )
    expect(writeWorkspaceFile.mock.calls[0]?.[1]).toEqual(PNG_1X1)
  })

  it('reads reference paths through the host workspace and sends data URLs only inside the provider request', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const readWorkspaceFile = vi.fn(async (path: string) => ({ path, data: PNG_1X1, name: path }))
    const execution = context({ readWorkspaceFile })
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    await tool.execute({
      prompt: 'Keep the composition and change the color',
      referenced_image_paths: ['reference.png'],
    }, execution)

    expect(readWorkspaceFile).toHaveBeenCalledWith('reference.png', 20 * 1024 * 1024)
    expect(execution.validateImage).toHaveBeenCalledWith(expect.objectContaining({ data: PNG_1X1, mediaType: 'image/png' }))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(OPENAI_CODEX_IMAGE_EDITS_URL)
    expect(JSON.parse(init.body as string)).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${PNG_1X1.toString('base64')}` }],
    })
  })

  it('can use recent conversation image attachments without model-supplied bytes', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const recentImages = vi.fn(async () => [{ data: PNG_1X1, mediaType: 'image/png', name: 'prior.png' }])
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    await tool.execute({ prompt: 'Make a variation', num_last_images_to_include: 1 }, context({ recentImages }))

    expect(recentImages).toHaveBeenCalledWith(1)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({
      images: [{ image_url: `data:image/png;base64,${PNG_1X1.toString('base64')}` }],
    })
  })

  it('rejects ambiguous reference selection before making a provider request', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    await expect(tool.execute({
      prompt: 'Edit this', referenced_image_paths: ['one.png'], num_last_images_to_include: 1,
    }, context())).rejects.toThrow('provide only one')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a text-only caller before generated image bytes enter its history', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!

    await expect(tool.execute({ prompt: 'A tiny pixel' }, context({
      model: { provider: 'openai-codex', model: 'gpt-5.3-codex-spark', inputModalities: ['text'] },
    }))).rejects.toThrow('does not declare image input')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honors the setting that disables imagegen for another model provider', async () => {
    const fetchMock = successfulFetch()
    vi.stubGlobal('fetch', fetchMock)
    const tool = imagegenTool(
      credentials(), new ImageToolPolicy({ shareImagegenWithOtherModels: false }),
    ).resolve()!

    await expect(tool.execute({ prompt: 'A tiny pixel' }, context({
      model: { provider: 'another-provider', model: 'vision-model', inputModalities: ['text', 'image'] },
    }))).rejects.toThrow('disabled for models outside')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the attachment but reports output_path failures from the host policy', async () => {
    vi.stubGlobal('fetch', successfulFetch())
    const tool = imagegenTool(credentials(), new ImageToolPolicy()).resolve()!
    const execution = context({ writeWorkspaceFile: vi.fn(async () => { throw new Error('read-only mode') }) })

    const result = await tool.execute({ prompt: 'A tiny pixel', output_path: 'blocked.png' }, execution)

    expect(result.content.some(block => block.type === 'image')).toBe(true)
    expect(result.content.find(block => block.type === 'text')?.text).toContain('read-only mode')
    expect(result.data).toMatchObject({ writeError: expect.stringContaining('read-only mode') })
  })
})
