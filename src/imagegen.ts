/** ChatGPT Codex image generation and reference-image editing. */

import { randomUUID } from 'node:crypto'
import { createModels } from '@earendil-works/pi-ai'
import type { Models } from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import type {
  ExecutableToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
  ToolImageData,
  ToolJsonValue,
} from '@dsh-std/tool'
import type { OpenAICodexCredentialStore } from './store.ts'
import { OPENAI_CODEX_PROVIDER } from './store.ts'
import { OPENAI_CODEX_BASE_URL } from './search.ts'
import { imageMediaType } from './read-image.ts'
import type { ImageToolPolicy } from './preferences.ts'
import { assertImageCapable } from './image-capability.ts'

/** Stable Codex-compatible tool name. */
export const IMAGEGEN_TOOL_NAME = 'imagegen'
/** Image model selected by the official Codex image extension. */
export const OPENAI_CODEX_IMAGE_MODEL = 'gpt-image-2'
/** Standalone generation endpoint used by the official Codex client. */
export const OPENAI_CODEX_IMAGE_GENERATIONS_URL = `${OPENAI_CODEX_BASE_URL}/images/generations`
/** Reference-image edit endpoint used by the official Codex client. */
export const OPENAI_CODEX_IMAGE_EDITS_URL = `${OPENAI_CODEX_BASE_URL}/images/edits`

const MAX_REFERENCE_IMAGES = 5
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function defaultOutputPath(now = new Date(), id = randomUUID()): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/u, 'Z').replaceAll(':', '-')
  return `generated-${timestamp}-${id.slice(0, 8)}.png`
}

interface ImagegenArgs {
  prompt: string
  referenced_image_paths?: string[]
  num_last_images_to_include?: number
  output_path?: string
}

interface ImagegenValue {
  prompt: string
  image: {
    attachmentId?: string
    mediaType: 'image/png'
    bytes: number
    width: number
    height: number
    name?: string
  }
  file?: {
    path: string
    operation: 'create' | 'update'
  }
  writeError?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function accountIdFromToken(access: string): string {
  try {
    const parts = access.split('.')
    if (parts.length !== 3 || parts[1] === undefined) throw new Error('invalid JWT')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth']
    if (!isRecord(auth)) throw new Error('missing auth claim')
    const accountId = auth['chatgpt_account_id']
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('missing account id')
    return accountId
  } catch (error: unknown) {
    throw new Error('OpenAI Codex image credential has no usable account id; run "dsh openai-codex login" again', { cause: error })
  }
}

function providerMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const error = value['error']
  const raw = typeof error === 'string'
    ? error
    : isRecord(error) && typeof error['message'] === 'string'
      ? error['message']
      : typeof value['message'] === 'string' ? value['message'] : undefined
  return raw?.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[REDACTED]').slice(0, 1000)
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    void operation.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/** OAuth-backed client for the two fixed ChatGPT Codex image endpoints. */
export class OpenAICodexImageClient {
  private readonly models: Models

  /** @param credentials - shared refreshable OAuth store. */
  constructor(credentials: OpenAICodexCredentialStore) {
    const models = createModels({ credentials })
    models.setProvider(openaiCodexProvider())
    this.models = models
  }

  /** Send one generation or edit request and return the first PNG payload. */
  async generate(
    prompt: string,
    images: readonly string[],
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    throwIfAborted(signal)
    const auth = await abortable(this.models.getAuth(OPENAI_CODEX_PROVIDER), signal)
    const access = auth?.auth.apiKey
    if (access === undefined || access.length === 0) {
      throw new Error('OpenAI Codex image generation is signed out; run "dsh openai-codex login"')
    }
    const endpoint = images.length === 0
      ? OPENAI_CODEX_IMAGE_GENERATIONS_URL
      : OPENAI_CODEX_IMAGE_EDITS_URL
    const body = {
      ...images.length === 0 ? {} : { images: images.map(image_url => ({ image_url })) },
      prompt,
      background: 'auto',
      model: OPENAI_CODEX_IMAGE_MODEL,
      quality: 'auto',
      size: 'auto',
    }
    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${access}`,
          'chatgpt-account-id': accountIdFromToken(access),
          'content-type': 'application/json',
          accept: 'application/json',
          originator: 'deepseek-harness',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      throwIfAborted(signal)
      throw new Error('OpenAI Codex image request failed', { cause: error })
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error: unknown) {
      throw new Error(`OpenAI Codex returned an unprocessable image response (HTTP ${response.status})`, { cause: error })
    }
    if (!response.ok) {
      const detail = providerMessage(payload)
      const message = detail === undefined
        ? `OpenAI Codex image request failed (HTTP ${response.status})`
        : `OpenAI Codex image request failed (HTTP ${response.status}): ${detail}`
      throw new Error(response.status === 401 || response.status === 403
        ? `${message}; run "dsh openai-codex login" again`
        : message)
    }
    if (!isRecord(payload) || !Array.isArray(payload['data'])) {
      throw new Error('OpenAI Codex returned an image response without data')
    }
    const first = payload['data'][0]
    if (!isRecord(first) || typeof first['b64_json'] !== 'string' || first['b64_json'].length === 0) {
      throw new Error('OpenAI Codex returned an image response without base64 image data')
    }
    const encoded = first['b64_json'].trim()
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error('OpenAI Codex returned malformed base64 image data')
    }
    return Buffer.from(encoded, 'base64')
  }
}

function attachmentId(reference: unknown): string | undefined {
  return isRecord(reference) && typeof reference['attachmentId'] === 'string'
    ? reference['attachmentId']
    : undefined
}

function contentOf(value: ImagegenValue, reference: unknown): ToolExecutionResult['content'] {
  const file = value.file === undefined
    ? value.writeError === undefined ? '' : `\n<output_error>${value.writeError}</output_error>`
    : `\n<output_path operation="${value.file.operation}">${value.file.path}</output_path>`
  return [
    {
      type: 'text',
      text: `<image>${value.image.mediaType}, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>${file}`,
    },
    { type: 'image', reference },
  ]
}

function dataUrl(image: ToolImageData): string {
  return `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`
}

async function conversationImages(context: ToolExecutionContext, count: number): Promise<string[]> {
  const images = await context.recentImages(count)
  return images.map(dataUrl)
}

async function workspaceImages(context: ToolExecutionContext, paths: readonly string[]): Promise<string[]> {
  const maxBytes = context.imageLimits === undefined
    ? MAX_IMAGE_BYTES
    : Math.min(context.imageLimits.maxImageBytes, context.imageLimits.maxMessageImageBytes)
  const images: string[] = []
  for (const path of paths) {
    if (path.trim().length === 0) throw new Error('referenced_image_paths must not contain an empty path')
    const file = await context.readWorkspaceFile(path, maxBytes)
    const mediaType = imageMediaType(file.data)
    if (mediaType === undefined) throw new Error(`referenced image is not PNG, JPEG, WebP, or GIF: ${path}`)
    await context.validateImage({ data: file.data, mediaType, name: file.name ?? file.path })
    images.push(`data:${mediaType};base64,${Buffer.from(file.data).toString('base64')}`)
  }
  return images
}

function parseArgs(raw: Readonly<Record<string, ToolJsonValue>>): ImagegenArgs {
  const prompt = raw['prompt']
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw new Error('imagegen prompt must not be empty')
  const rawPaths = raw['referenced_image_paths']
  if (rawPaths !== undefined && (!Array.isArray(rawPaths) || rawPaths.some(path => typeof path !== 'string'))) {
    throw new Error('referenced_image_paths must be an array of strings')
  }
  const paths = rawPaths as string[] | undefined ?? []
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`referenced_image_paths must contain at most ${MAX_REFERENCE_IMAGES} paths`)
  }
  const count = raw['num_last_images_to_include']
  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_REFERENCE_IMAGES)) {
    throw new Error(`num_last_images_to_include must be an integer between 1 and ${MAX_REFERENCE_IMAGES}`)
  }
  if (paths.length > 0 && count !== undefined) {
    throw new Error('provide only one of referenced_image_paths or num_last_images_to_include')
  }
  const outputPath = raw['output_path']
  if (outputPath !== undefined && (typeof outputPath !== 'string' || outputPath.trim().length === 0)) {
    throw new Error('output_path must not be empty')
  }
  return {
    prompt: prompt.trim(),
    ...paths.length === 0 ? {} : { referenced_image_paths: paths },
    ...count === undefined ? {} : { num_last_images_to_include: count },
    ...outputPath === undefined ? {} : { output_path: outputPath },
  }
}

function imagegenDefinition(
  policy: ImageToolPolicy,
  client: Pick<OpenAICodexImageClient, 'generate'>,
): ExecutableToolDefinition {
  return {
    name: IMAGEGEN_TOOL_NAME,
    description: 'Generate or edit an image with gpt-image-2. Omit both reference fields for a new image. Use referenced_image_paths for workspace files, or num_last_images_to_include for attached, viewed, or previously generated conversation images. Never provide both. Multiple images keep chronological/path-array order; identify them as Image 1, Image 2, and so on in the prompt. The generated PNG is always saved in the active local or Remote SSH workspace; output_path chooses its location, otherwise a unique generated-<timestamp>-<id>.png name is used.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1, description: 'Complete generation or edit instruction. For multiple references, name each input by its Image N order.' },
        referenced_image_paths: { type: 'array', maxItems: 5, items: { type: 'string', minLength: 1 }, description: 'Up to five local or active-workspace image paths, in Image 1..N order.' },
        num_last_images_to_include: { type: 'integer', minimum: 1, maximum: 5, description: 'Use the most recent 1–5 conversation images, preserving chronological order.' },
        output_path: { type: 'string', minLength: 1, description: 'Optional active-workspace path for the generated PNG. Omit it to save under a unique generated-<timestamp>-<id>.png name. Existing files remain subject to filesystem write-intent policy.' },
      },
    },
    output: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'image'],
      properties: {
        prompt: { type: 'string' },
        image: {
          type: 'object',
          required: ['mediaType', 'bytes', 'width', 'height'],
          additionalProperties: false,
          properties: {
            attachmentId: { type: 'string' },
            mediaType: { type: 'string', enum: ['image/png'] },
            bytes: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
            name: { type: 'string' },
          },
        },
        file: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'operation'],
          properties: {
            path: { type: 'string' },
            operation: { type: 'string', enum: ['create', 'update'] },
          },
        },
        writeError: { type: 'string' },
      },
    },
    isConcurrencySafe: args => args['output_path'] === undefined,
    async execute(rawArgs, context) {
      const args = parseArgs(rawArgs)
      policy.assertAllowed(context.model?.provider, 'imagegen')
      assertImageCapable(context, 'generate an image')
      const images = args.referenced_image_paths !== undefined
        ? await workspaceImages(context, args.referenced_image_paths)
        : args.num_last_images_to_include !== undefined
          ? await conversationImages(context, args.num_last_images_to_include)
          : []
      const data = await client.generate(args.prompt, images, context.signal)
      const mediaType = imageMediaType(data)
      if (mediaType !== 'image/png') throw new Error('OpenAI Codex image response was not a PNG')
      const stored = await context.saveImage({ data, mediaType, name: 'generated.png' })
      const id = attachmentId(stored.reference)
      const value: ImagegenValue = {
        prompt: args.prompt,
        image: {
          ...(id === undefined ? {} : { attachmentId: id }),
          mediaType,
          bytes: stored.bytes,
          width: stored.width,
          height: stored.height,
          ...stored.name === undefined ? {} : { name: stored.name },
        },
      }
      const outputPath = args.output_path ?? defaultOutputPath()
      try {
        const outcome = await context.writeWorkspaceFile(outputPath, data)
        value.file = { path: outcome.path, operation: outcome.operation }
      } catch (error: unknown) {
        throwIfAborted(context.signal)
        const detail = (error instanceof Error ? error.message : String(error)).slice(0, 1000)
        value.writeError = `generated image was not written to ${JSON.stringify(outputPath)}: ${detail}`
      }
      const content = contentOf(value, stored.reference)
      context.deferContent?.(content)
      return { data: value as unknown as ToolJsonValue, content }
    },
  }
}

/** Build the plugin-owned Codex image generation and editing tool. */
export function imagegenTool(
  credentials: OpenAICodexCredentialStore,
  policy: ImageToolPolicy,
  client: Pick<OpenAICodexImageClient, 'generate'> = new OpenAICodexImageClient(credentials),
): ToolHandler {
  return { resolve: () => imagegenDefinition(policy, client) }
}
