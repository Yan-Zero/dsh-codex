/** Browser half: standard UI facet mapped to DSH Web by @dsh-std/adapter-dsh. */

import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  defineDshWebUiFacet,
  WEB_CLIENT_ACTIVATION_API_VERSION,
  WEB_CLIENT_ACTIVATION_KIND,
  WEB_SETTINGS_SECTION,
  WEB_TOOL_CALL_VIEW,
  webSettingsSectionRequirement,
  webToolCallViewRequirement,
  type DshWebLocalHost,
} from '@dsh-std/adapter-dsh/client'
import { defineComponentManifest } from '@dsh-std/manifest'
import { defineFacet } from '@dsh-std/sdk'
import { contributionHostRequirement, type ContributionHostClient } from '@dsh-std/ui'
import { ImagegenToolView, type ImageLoader } from './ImagegenToolView.tsx'
import { OpenAICodexSettings } from './OpenAICodexSettings.tsx'
import { en, zh, type OpenAICodexSettingsKey } from './locales.ts'

const manifest = defineComponentManifest({
  apiVersion: 'manifest.dsh/internal/v1alpha1',
  kind: 'Component',
  metadata: { name: 'ai.openai.codex.web', version: '0.2.4' },
  spec: { facets: [{
    name: 'web',
    activation: {
      apiVersion: WEB_CLIENT_ACTIVATION_API_VERSION,
      kind: WEB_CLIENT_ACTIVATION_KIND,
      spec: { module: './client.js' },
    },
    protocols: { requires: [contributionHostRequirement({ surfaces: [
      webSettingsSectionRequirement(),
      webToolCallViewRequirement(),
    ] })] },
  }] },
})

const facet = defineFacet(activation => {
  const ui = activation.protocols.client<ContributionHostClient>({
    apiVersion: 'ui.dsh/v1alpha1', kind: 'ContributionHost',
  })
  if (ui === undefined) throw new Error('OpenAI Codex Web facet requires a ContributionHost')
  const settings = ui.register({
    descriptor: {
      id: 'openai-codex', surface: WEB_SETTINGS_SECTION,
      content: { label: 'OpenAI Codex', order: 15 },
    },
    localModule: {
      component: OpenAICodexSettings,
      setup(host: DshWebLocalHost) {
        const locale = host.locale('settings.openai-codex', { zh, en })
        return {
          locale: 'settings.openai-codex',
          label: () => locale.t('nav'),
          inject: () => ({
            t: locale.t as (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string,
            runCommand: host.executeCommand,
          }),
          dispose: locale.dispose,
        }
      },
    },
  })
  const tool = ui.register({
    descriptor: {
      id: 'imagegen', surface: WEB_TOOL_CALL_VIEW,
      content: { tool: 'imagegen' },
    },
    localModule: {
      component: ImagegenToolView,
      setup(host: DshWebLocalHost) {
        const locale = host.locale('tool.openai-codex', { zh, en })
        const imageUrls = new Map<string, Promise<string>>()
        const createdUrls = new Set<string>()
        const inject = (...args: unknown[]) => {
          const sessionId = args[0]
          if (typeof sessionId !== 'string' || sessionId === '') throw new Error('imagegen ToolCallView requires a session id')
          const loadImage: ImageLoader = (attachment: ImageAttachmentRef) => {
            const key = `${sessionId}:${attachment.attachmentId}`
            const cached = imageUrls.get(key)
            if (cached !== undefined) return cached
            const pending = host.readAttachment(sessionId, attachment.attachmentId).then(result => {
              const url = URL.createObjectURL(new Blob([result.data.buffer as ArrayBuffer], { type: result.mediaType }))
              createdUrls.add(url)
              return url
            }).catch((error: unknown) => {
              imageUrls.delete(key)
              throw error
            })
            imageUrls.set(key, pending)
            return pending
          }
          return {
            loadImage,
            t: locale.t as (key: OpenAICodexSettingsKey, params?: Record<string, unknown>) => string,
          }
        }
        return {
          locale: 'tool.openai-codex',
          inject,
          dispose: () => {
            for (const url of createdUrls) URL.revokeObjectURL(url)
            createdUrls.clear()
            imageUrls.clear()
            locale.dispose()
          },
        }
      },
    },
  })
  activation.scope.add(() => settings.dispose())
  activation.scope.add(() => tool.dispose())
})

const plugin = defineDshWebUiFacet({ manifest, facet: 'web', module: facet })

export const name = plugin.name
export const inject = plugin.inject
export const apply = plugin.apply
export default plugin
