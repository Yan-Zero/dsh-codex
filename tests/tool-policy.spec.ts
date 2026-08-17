import { describe, expect, it } from 'vitest'
import { ImageToolPolicy } from '../src/tool-policy.ts'

describe('ImageToolPolicy', () => {
  it('applies independent live toggles without depending on a host settings API', async () => {
    const policy = new ImageToolPolicy()

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: true,
    })
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: false,
    })

    await policy.update({ shareImagegenWithOtherModels: false })
    await policy.updateResponseApi({ useNativeCompaction: true })

    expect(policy.snapshot()).toEqual({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    })
    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: false,
      useNativeCompaction: true,
    })
  })

  it('notifies the read_image enhancer when its live setting changes', async () => {
    const policy = new ImageToolPolicy({
      modifyReadImage: true,
      shareImagegenWithOtherModels: false,
    })
    let changes = 0
    policy.watchImagePreferences(() => { changes++ })

    await policy.update({ modifyReadImage: false })

    expect(policy.snapshot().modifyReadImage).toBe(false)
    expect(changes).toBe(1)
  })

  it('migrates the retired store:true preference to WebSocket context reuse', () => {
    const policy = new ImageToolPolicy({ useStatefulResponses: true })

    expect(policy.responseApiSnapshot()).toEqual({
      useWebSocketContextReuse: true,
      useNativeCompaction: false,
    })
  })

  it('keeps Codex imagegen access while applying its toggle to another provider', () => {
    const policy = new ImageToolPolicy({ shareImagegenWithOtherModels: false })
    expect(() => policy.assertAllowed('openai-codex', 'imagegen')).not.toThrow()
    expect(() => policy.assertAllowed('another-provider', 'imagegen')).toThrow('disabled for models outside')
  })
})
