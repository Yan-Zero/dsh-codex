/** Optional HTTP(S) input for the existing `read_image` tool. */

import { basename } from 'node:path'
import type {
  ExecutableToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolJsonValue,
  ToolOverrideHandler,
} from '@dsh-std/tool'
import type { ImageToolPolicy } from './preferences.ts'
import { assertImageCapable } from './image-capability.ts'

/** Canonical image-reading tool name. */
export const READ_IMAGE_TOOL_NAME = 'read_image'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export type SupportedImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

interface ReadImageValue {
  path: string
  image: {
    attachmentId?: string
    mediaType: SupportedImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

function attachmentId(reference: unknown): string | undefined {
  return typeof reference === 'object' && reference !== null && !Array.isArray(reference)
    && typeof (reference as Record<string, unknown>)['attachmentId'] === 'string'
    ? (reference as Record<string, unknown>)['attachmentId'] as string
    : undefined
}

function contentOf(value: ReadImageValue, reference: unknown): ToolExecutionResult['content'] {
  return [
    {
      type: 'text',
      text: `<path>${value.path}</path>\n<type>image</type>\n<content>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</content>`,
    },
    { type: 'image', reference },
  ]
}

/** Detect one supported encoded raster format from its magic bytes. */
export function imageMediaType(data: Uint8Array): SupportedImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

async function boundedResponseBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`remote image exceeds ${maxBytes} bytes`)
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      if (signal.aborted) throw signal.reason
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxBytes) throw new Error(`remote image exceeds ${maxBytes} bytes`)
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

async function fetchImage(source: string, maxBytes: number, signal: AbortSignal): Promise<{
  data: Uint8Array
  display: string
  name?: string
}> {
  let url = new URL(source)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('read_image URL must use http or https')
  if (url.username !== '' || url.password !== '') throw new Error('read_image URL must not contain credentials')
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'image/png, image/jpeg, image/webp, image/gif' },
      signal,
    })
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= 5) throw new Error('remote image exceeded 5 redirects')
      const location = response.headers.get('location')
      if (location === null) throw new Error(`remote image redirect ${response.status} has no location`)
      url = new URL(location, url)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('remote image redirected outside http(s)')
      if (url.username !== '' || url.password !== '') throw new Error('remote image redirect contains credentials')
      continue
    }
    if (!response.ok) throw new Error(`remote image request failed with HTTP ${response.status}`)
    const name = basename(url.pathname) || undefined
    return {
      data: await boundedResponseBytes(response, maxBytes, signal),
      display: url.href,
      ...name === undefined ? {} : { name },
    }
  }
}

function stringArgument(input: Readonly<Record<string, ToolJsonValue>>, name: string): string | undefined {
  const value = input[name]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Build a live ToolOverride that delegates workspace paths to the original tool. */
export function enhancedReadImageTool(policy: ImageToolPolicy): ToolOverrideHandler {
  return {
    resolve(original: ExecutableToolDefinition): ExecutableToolDefinition | undefined {
      if (!policy.snapshot().modifyReadImage) return undefined
      return {
        name: READ_IMAGE_TOOL_NAME,
        description: 'Read a PNG/JPEG/WebP/GIF image from a workspace file path or an HTTP(S) URL and return the image itself. Requires the current model to accept image input.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            file_path: {
              type: 'string',
              description: 'Local image path resolved by the active filesystem backend. Provide exactly one of file_path or url.',
            },
            url: {
              type: 'string',
              description: 'HTTP(S) image URL. Provide exactly one of file_path or url.',
            },
          },
        },
        output: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'image'],
          properties: {
            path: { type: 'string' },
            image: {
              type: 'object',
              additionalProperties: false,
              required: ['mediaType', 'bytes', 'width', 'height'],
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
            },
          },
        },
        isConcurrencySafe: args => args['url'] !== undefined || original.isConcurrencySafe?.(
          args['file_path'] === undefined ? {} : { file_path: args['file_path'] },
        ) === true,
        async execute(args, context) {
          const filePath = stringArgument(args, 'file_path')
          const sourceUrl = stringArgument(args, 'url')
          if ((filePath === undefined) === (sourceUrl === undefined)) {
            throw new Error('read_image requires exactly one non-empty file_path or url')
          }
          if (filePath !== undefined) {
            if (context.delegate === undefined) throw new Error('read_image override cannot reach the original workspace reader')
            return context.delegate({ file_path: filePath })
          }

          const url = sourceUrl as string
          assertImageCapable(context, `read ${JSON.stringify(url)}`)
          const maxBytes = context.imageLimits === undefined
            ? MAX_IMAGE_BYTES
            : Math.min(context.imageLimits.maxImageBytes, context.imageLimits.maxMessageImageBytes)
          const loaded = await fetchImage(url, maxBytes, context.signal)
          const mediaType = imageMediaType(loaded.data)
          if (mediaType === undefined) throw new Error('read_image supports PNG, JPEG, WebP, and GIF image bytes')
          if (context.imageLimits !== undefined && !context.imageLimits.mediaTypes.includes(mediaType)) {
            throw new Error(`${mediaType} images are disabled by this deployment`)
          }
          const ref = await context.saveImage({
            data: loaded.data,
            mediaType,
            ...loaded.name === undefined ? {} : { name: loaded.name },
          })
          const id = attachmentId(ref.reference)
          const value: ReadImageValue = {
            path: loaded.display,
            image: {
              ...id === undefined ? {} : { attachmentId: id },
              mediaType: ref.mediaType as SupportedImageMediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...ref.name === undefined ? {} : { name: ref.name },
            },
          }
          const result: ToolExecutionResult = {
            data: value as unknown as ToolJsonValue,
            content: contentOf(value, ref.reference),
          }
          context.deferContent?.(result.content)
          return result
        },
      }
    },
    subscribe(invalidate: () => void): () => void {
      return policy.watchImagePreferences(invalidate)
    },
  }
}
