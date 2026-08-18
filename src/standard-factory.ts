/** Internal facet factory used by the package entrypoint and boundary tests. */

import { defineFacet } from '@dsh-std/sdk'
import type { FacetModule } from '@dsh-std/sdk'
import { OpenAICodexCommand } from './command.ts'
import { OpenAICodexService } from './service.ts'
import { OpenAICodexModelHandler } from './model-handler.ts'
import { imagegenTool } from './imagegen.ts'
import { enhancedReadImageTool } from './read-image.ts'
import { openAICodexSearchTool } from './search-tool.ts'
import {
  OPENAI_CODEX_TUI_SCENE,
  TUI_API_VERSION,
  TUI_SCENE_KIND,
  openAICodexTuiScene,
} from './tui.ts'

/** Build the portable facet from product code and standard protocol handlers only. */
export function createOpenAICodexFacet(service = new OpenAICodexService({})): FacetModule {
  const command = new OpenAICodexCommand(() => service)
  const models = new OpenAICodexModelHandler(service.credentials, () => service.responsePreferences())
  const imagegen = imagegenTool(service.credentials, service.preferences)
  const readImage = enhancedReadImageTool(service.preferences)
  const search = openAICodexSearchTool(service.credentials)
  return defineFacet(
    activation => {
      activation.extensions.publish({ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }, 'codex', command)
      activation.extensions.publish({ apiVersion: 'models.dsh/v1alpha1', kind: 'ModelProvider' }, 'openai-codex', models)
      activation.extensions.publish({ apiVersion: 'tools.dsh/v1alpha1', kind: 'Tool' }, 'imagegen', imagegen)
      activation.extensions.publish({ apiVersion: 'tools.dsh/v1alpha1', kind: 'ToolOverride' }, 'openai-codex-read-image', readImage)
      activation.extensions.publish({ apiVersion: 'tools.dsh/v1alpha1', kind: 'ToolOverride' }, 'openai-codex-web-search', search)
      activation.extensions.publish(
        { apiVersion: TUI_API_VERSION, kind: TUI_SCENE_KIND },
        OPENAI_CODEX_TUI_SCENE,
        openAICodexTuiScene,
      )
      activation.scope.add(() => command.dispose())
    },
    undefined,
    async () => {
      const authenticated = (await service.authStatus()).authenticated
      const imagegenDefinition = imagegen.resolve()
      return {
        extensions: [
          {
            apiVersion: 'models.dsh/v1alpha1', kind: 'ModelProvider', name: 'openai-codex',
            status: {
              state: authenticated ? 'ready' as const : 'authentication-required' as const,
              models: service.models().map(model => ({
                ...model, selectable: authenticated,
                ...(authenticated ? {} : { reason: 'authentication-required' as const }),
              })),
            },
          },
          {
            apiVersion: 'tools.dsh/v1alpha1', kind: 'Tool', name: 'imagegen',
            status: authenticated && imagegenDefinition !== undefined
              ? {
                  state: 'available' as const,
                  description: imagegenDefinition.description,
                  parameters: imagegenDefinition.parameters,
                }
              : { state: 'unavailable' as const, reason: 'authentication-required' },
          },
        ],
      }
    },
  )
}
