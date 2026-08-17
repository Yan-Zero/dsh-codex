import { describe, expect, it, vi } from 'vitest'
import { loadCodexRuntimeAvailability } from '../src/client/standard-runtime.ts'

describe('Codex standard Runtime projection', () => {
  it('does not treat a locally loaded browser contribution as remotely installed', async () => {
    const request = vi.fn(async () => new Response(undefined, { status: 404 }))
    await expect(loadCodexRuntimeAvailability(request, 'remote-host'))
      .resolves.toEqual({ state: 'not-installed', runtime: 'remote-host' })
  })

  it('distinguishes an available backend from a failing one', async () => {
    await expect(loadCodexRuntimeAvailability(
      vi.fn(async () => new Response('{}', { status: 200 })),
    )).resolves.toEqual({ state: 'installed' })
    await expect(loadCodexRuntimeAvailability(
      vi.fn(async () => new Response(undefined, { status: 503 })),
    )).resolves.toEqual({ state: 'unavailable', message: 'HTTP 503' })
  })
})
