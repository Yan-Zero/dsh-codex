/** Browser half: OpenAI Codex account management inside dsh Settings. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import type { OpenAICodexSettingsInjected } from './OpenAICodexSettings.tsx'
import { ImagegenToolView } from './ImagegenToolView.tsx'
import type { ImageLoader } from './ImagegenToolView.tsx'
import { OpenAICodexFastModeToggle } from './OpenAICodexFastModeToggle.tsx'
import type { OpenAICodexFastModeToggleInjected } from './OpenAICodexFastModeToggle.tsx'
import { OpenAICodexQuotaIndicator } from './OpenAICodexQuotaIndicator.tsx'
import type { OpenAICodexQuotaIndicatorInjected } from './OpenAICodexQuotaIndicator.tsx'
import { en, zh } from './locales.ts'
import type { OpenAICodexSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** OpenAI Codex account page copy. */
    'settings.openai-codex': OpenAICodexSettingsKey
  }
}

/** Stable browser-plugin name. */
export const name = 'dsh-codex-client'
/** Client services required by the settings contribution. */
export const inject = ['slots', 'locale', 'sessions']

/** Register account copy and the OpenAI Codex settings page. */
export function apply(ctx: ClientContext): void {
  const namespace = 'settings.openai-codex'
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }), 'dsh-openai-codex: settings copy')
  const t = ctx.locale.bind(namespace) as OpenAICodexSettingsInjected['t']
  const imageUrls = new Map<string, Promise<string>>()
  const createdUrls = new Set<string>()
  const loadImage = (sessionId: SessionId, attachment: ImageAttachmentRef): Promise<string> => {
    const key = `${sessionId}:${attachment.attachmentId}`
    const cached = imageUrls.get(key)
    if (cached !== undefined) return cached
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) return Promise.reject(new Error(`unknown session ${sessionId}`))
    const pending = session.readAttachment(attachment.attachmentId).then(result => {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const bytes = Uint8Array.from(result.value.data)
      const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: result.value.attachment.mediaType }))
      createdUrls.add(url)
      return url
    }).catch((error: unknown) => {
      imageUrls.delete(key)
      throw error
    })
    imageUrls.set(key, pending)
    return pending
  }
  ctx.effect(() => () => {
    for (const url of createdUrls) URL.revokeObjectURL(url)
    createdUrls.clear()
    imageUrls.clear()
  }, 'dsh-openai-codex: release image URLs')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'openai-codex',
    order: 15,
    label: () => t('nav'),
    inject: (): OpenAICodexSettingsInjected => ({ t }),
  }, OpenAICodexSettings))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'imagegen',
    inject: (sessionId: SessionId): { loadImage: ImageLoader; t: OpenAICodexSettingsInjected['t'] } => ({
      loadImage: attachment => loadImage(sessionId, attachment),
      t,
    }),
  }, ImagegenToolView))
  ctx.inject(['slots', 'modelDirectories'], scope => {
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'openai-codex-fast-mode',
      order: 10,
      locale: namespace,
      inject: (sessionId): OpenAICodexFastModeToggleInjected => ({
        directory: scope.modelDirectories.directoryFor(sessionId).store,
      }),
    }, OpenAICodexFastModeToggle))
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'openai-codex-quota',
      order: 20,
      locale: namespace,
      inject: (sessionId): OpenAICodexQuotaIndicatorInjected => ({
        directory: scope.modelDirectories.directoryFor(sessionId).store,
      }),
    }, OpenAICodexQuotaIndicator))
  })
}
