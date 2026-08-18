/** Host facet entrypoint declared by dsh-plugin.json. */

import type { FacetModule } from '@dsh-std/sdk'
import { createOpenAICodexFacet } from './standard-factory.ts'

const facet: FacetModule = createOpenAICodexFacet()

export default facet
