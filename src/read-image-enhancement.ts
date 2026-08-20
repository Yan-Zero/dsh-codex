/** Optional HTTP(S) input for Harness's existing `read_image` tool. */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { assertImageCapable } from './image-capability.ts'
import type { ImageToolPolicy } from './tool-policy.ts'
import { fetchPublicHttpResource } from './public-http.ts'
import type { PublicHttpRuntime } from './public-http.ts'

/** Harness's canonical image-reading tool name. */
export const READ_IMAGE_TOOL_NAME = 'read_image'

interface ReadImageValue {
  path: string
  image: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

function refOf(image: ReadImageValue['image']): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

function contentOf(value: ReadImageValue): ContentBlock[] {
  return [
    {
      type: 'text',
      text: `<path>${value.path}</path>\n<type>image</type>\n<content>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</content>`,
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

/** Build an agent-scoped `read_image` definition that delegates local paths to Harness. */
export function enhancedReadImageTool(
  ctx: Context,
  original: ToolDefinition,
  publicHttpRuntime?: PublicHttpRuntime,
): ToolDefinition {
  return defineTool({
    name: READ_IMAGE_TOOL_NAME,
    description: 'Read a PNG/JPEG/WebP/GIF image from a workspace file path or an HTTP(S) URL and return the image itself. Requires the current model to accept image input.',
    parameters: {
      file_path: {
        type: 'string',
        description: 'Local image path resolved by the active filesystem backend. Provide exactly one of file_path or url.',
      },
      url: {
        type: 'string',
        description: 'HTTP(S) image URL. Provide exactly one of file_path or url.',
      },
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
      render: (_args, value) => contentOf(value),
    },
    isConcurrencySafe: args => args.url !== undefined || original.isConcurrencySafe?.({ file_path: args.file_path }) === true,
    async execute(args, exec) {
      const filePath = args.file_path?.trim()
      const sourceUrl = args.url?.trim()
      if ((filePath === undefined || filePath.length === 0) === (sourceUrl === undefined || sourceUrl.length === 0)) {
        throw new Error('read_image requires exactly one non-empty file_path or url')
      }
      if (filePath !== undefined && filePath.length > 0) {
        return await original.execute({ file_path: filePath }, exec) as ReadImageValue
      }

      const url = sourceUrl as string
      await assertImageCapable(ctx, exec, `read ${JSON.stringify(url)}`)
      const attachments = ctx.attachments
      const maxBytes = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
      const loaded = await fetchPublicHttpResource(url, maxBytes, exec.signal, publicHttpRuntime)
      const mediaType = imageMediaType(loaded.data)
      if (mediaType === undefined) throw new Error('read_image supports PNG, JPEG, WebP, and GIF image bytes')
      if (!attachments.imageLimits.mediaTypes.includes(mediaType)) {
        throw new Error(`${mediaType} images are disabled by this deployment`)
      }
      const ref = await attachments.saveImage({
        data: loaded.data,
        mediaType,
        ...loaded.name === undefined ? {} : { name: loaded.name },
      })
      const value: ReadImageValue = {
        path: loaded.display,
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
    presentCall: args => {
      if (args.file_path !== undefined) return original.presentCall?.({ file_path: args.file_path })
      return {
        card: 'generic',
        title: `Read image ${args.url ?? ''}`,
        kind: 'read',
      }
    },
  })
}

interface ScopedEnhancement {
  readonly original: ToolDefinition
  readonly dispose: () => void
}

/** Keep an enhanced `read_image` shadow on every live agent while the setting is enabled. */
export function installReadImageEnhancement(
  ctx: Context,
  policy: ImageToolPolicy,
  publicHttpRuntime?: PublicHttpRuntime,
): void {
  const installed = new Map<Agent, ScopedEnhancement>()
  let syncing = false

  const remove = (agent: Agent): void => {
    const current = installed.get(agent)
    if (current === undefined) return
    installed.delete(agent)
    current.dispose()
  }

  const syncAgent = (agent: Agent): void => {
    const current = installed.get(agent)
    const original = ctx.tools.get(READ_IMAGE_TOOL_NAME)
    if (!policy.snapshot().modifyReadImage || original === undefined) {
      remove(agent)
      return
    }
    if (current?.original === original) return
    if (current !== undefined) remove(agent)
    if (ctx.tools.get(READ_IMAGE_TOOL_NAME, agent) !== original) return
    const dispose = agent.ctx.tools.register(enhancedReadImageTool(ctx, original, publicHttpRuntime))
    installed.set(agent, { original, dispose })
  }

  const syncAll = (): void => {
    if (syncing) return
    syncing = true
    try {
      for (const agent of ctx.agents.list()) syncAgent(agent)
      for (const agent of [...installed.keys()]) {
        if (ctx.agents.get(agent.id) !== agent) remove(agent)
      }
    } finally {
      syncing = false
    }
  }

  ctx.on('agent/created', ({ agent }) => { syncAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => { installed.delete(agent) })
  ctx.on('tools/change', syncAll)
  const stopPolicy = policy.watchImagePreferences(syncAll)
  syncAll()
  ctx.effect(() => () => {
    stopPolicy()
    for (const agent of [...installed.keys()]) remove(agent)
  }, 'dsh-openai-codex: enhanced read_image')
}
