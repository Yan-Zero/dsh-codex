/** Codex-compatible `view_image` tool for local paths and HTTP(S) URLs. */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { assertImageCapable } from './image-capability.ts'
import type { ImageToolPolicy } from './tool-policy.ts'

/** Stable Codex tool name. */
export const VIEW_IMAGE_TOOL_NAME = 'view_image'

interface ViewImageValue {
  source: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

function refOf(image: ViewImageValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

function contentOf(value: ViewImageValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `<source>${value.source}</source>\n<image>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>`,
    },
    { type: 'image', attachment: refOf(value.image) },
  ]
}

/** Detect one supported encoded raster format from its magic bytes. */
export function imageMediaType(data: Uint8Array): ImageMediaType | undefined {
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
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('view_image URL must use http or https')
  if (url.username !== '' || url.password !== '') throw new Error('view_image URL must not contain credentials')
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

/** Build the plugin-owned image viewing tool. */
export function viewImageTool(ctx: Context, policy: ImageToolPolicy): ToolDefinition {
  return defineTool({
    name: VIEW_IMAGE_TOOL_NAME,
    description: 'View an image from a local file path or an http(s) URL. Returns the actual PNG, JPEG, WebP, or GIF image to vision-capable models.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'Local absolute/relative image path, or an http(s) image URL.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string', required: true },
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
      render: (_args, value) => contentOf(value),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const source = args.source.trim()
      if (source.length === 0) throw new Error('view_image source must not be empty')
      policy.assertAllowed(exec, 'view_image')
      await assertImageCapable(ctx, exec, `view ${JSON.stringify(source)}`)
      const attachments = ctx.attachments
      const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      let loaded: { data: Uint8Array; display: string; name?: string }
      if (/^https?:\/\//iu.test(source)) {
        loaded = await fetchImage(source, maxBytes, exec.signal)
      } else {
        const cwd = exec.agent?.session.header.cwd
        const target = await ctx.fs.resolve(source, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal })
        const info = await ctx.fs.stat(target, exec.signal)
        if (info === undefined) throw new Error(`image path does not exist: ${source}`)
        if (info.type !== 'file') throw new Error(`image path is not a regular file: ${source}`)
        loaded = {
          data: await ctx.fs.readBytes(target, exec.signal, maxBytes),
          display: target.displayPath,
          name: basename(target.displayPath),
        }
        ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      }
      const mediaType = imageMediaType(loaded.data)
      if (mediaType === undefined) throw new Error('view_image supports PNG, JPEG, WebP, and GIF image bytes')
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`${mediaType} images are disabled by this deployment`)
      }
      const ref = await attachments.saveImage({
        data: loaded.data,
        mediaType,
        ...loaded.name === undefined ? {} : { name: loaded.name },
      })
      const value: ViewImageValue = {
        source: loaded.display,
        image: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === undefined ? {} : { name: ref.name },
        },
      }
      if (exec.parent !== undefined) {
        exec.deferContext(createUserMessage({
          content: contentOf(value),
          source: { kind: 'plugin', plugin: 'dsh-openai-codex' },
        }))
      }
      return value
    },
    presentCall: args => ({
      card: 'generic',
      title: `View image ${args.source}`,
      kind: 'read',
      .../^https?:\/\//iu.test(args.source) ? {} : { locations: [{ path: args.source }] },
    }),
  })
}
