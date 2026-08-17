/** Host entrypoint declared by dsh-plugin.json. */

import { defineFacet } from '@dsh-std/sdk'
import type { FacetModule } from '@dsh-std/sdk'
import { OpenAICodexCommand } from './command.ts'
import { OpenAICodexService } from './service.ts'
import { OpenAICodexModelHandler } from './model-handler.ts'

/** Build the portable facet from product code and standard protocol handlers only. */
export function createOpenAICodexFacet(service = new OpenAICodexService({})): FacetModule {
  const command = new OpenAICodexCommand(() => service)
  const models = new OpenAICodexModelHandler(service.credentials, () => service.responsePreferences())
  return defineFacet(
  activation => {
    activation.extensions.publish({ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }, 'codex', command)
    activation.extensions.publish({ apiVersion: 'models.dsh/v1alpha1', kind: 'ModelProvider' }, 'openai-codex', models)
    activation.scope.add(() => command.dispose())
  },
  undefined,
  async () => {
    const authenticated = (await service.authStatus()).authenticated
    return {
      extensions: [{
        apiVersion: 'models.dsh/v1alpha1',
        kind: 'ModelProvider',
        name: 'openai-codex',
        status: {
          state: authenticated ? 'ready' as const : 'authentication-required' as const,
          models: service.models().map(model => ({
            ...model,
            selectable: authenticated,
            ...(authenticated ? {} : { reason: 'authentication-required' as const }),
          })),
        },
      }],
    }
  },
  )
}

export default createOpenAICodexFacet()
