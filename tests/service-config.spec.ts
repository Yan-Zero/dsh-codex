import { describe, expect, it } from 'vitest'
import { Config } from '../src/index.ts'
import { OpenAICodexService } from '../src/service.ts'
import { openAICodexAuthPath } from '../src/store.ts'
import { resolve } from 'node:path'

const preferences = {
  modifyReadImage: true,
  shareImagegenWithOtherModels: true,
  useWebSocketContextReuse: false,
  useNativeCompaction: false,
  contextWindow: null,
  overrideSparkContextWindow: false,
  fastModeDefault: false,
  proxyMode: 'off' as const,
  proxyUrl: '',
  modelCatalog: [],
}

describe('credentialFile configuration seam', () => {
  it('passes the explicit credential filename into the shared service store', () => {
    const filename = resolve('fixture-auth.json')
    const config = new Config({ credentialFile: filename })
    const service = new OpenAICodexService({ ...preferences, credentialFile: filename })
    expect(config.credentialFile).toBe(filename)
    expect(service.credentials.filename).toBe(filename)
  })

  it('retains the DSH_HOME-derived filename when credentialFile is absent', () => {
    const config = new Config()
    const service = new OpenAICodexService(preferences)
    expect(config.credentialFile).toBeUndefined()
    expect(service.credentials.filename).toBe(openAICodexAuthPath())
  })
})
