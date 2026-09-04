import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import {
  OPENAI_CODEX_FAST_MODE_PATH,
  OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
  registerOpenAICodexAuthRoutes,
} from '../src/auth-routes.ts'
import { FastModeRegistry } from '../src/fast-mode.ts'
import type { OpenAICodexCredentialStore } from '../src/store.ts'
import type { ImageToolPolicy } from '../src/tool-policy.ts'

const store = {} as OpenAICodexCredentialStore

interface CapturedRoute {
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

function routes(registry = new FastModeRegistry(), policy?: ImageToolPolicy): CapturedRoute[] {
  const captured: CapturedRoute[] = []
  const ctx = {
    webServer: {
      register(route: CapturedRoute) {
        captured.push(route)
        return () => undefined
      },
    },
    effect(factory: () => void | (() => void | Promise<void>)) {
      return factory()
    },
  } as unknown as Context
  registerOpenAICodexAuthRoutes(ctx, store, undefined, registry, policy)
  return captured
}

function request(options: {
  method: string
  url?: string
  origin?: string
  remoteAddress?: string
  contentType?: string
  body?: string
}): IncomingMessage {
  return {
    method: options.method,
    url: options.url ?? OPENAI_CODEX_FAST_MODE_PATH,
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    headers: {
      host: '127.0.0.1:3081',
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  } as unknown as IncomingMessage
}

function response(): ServerResponse & { status?: number; body?: string } {
  const observed: { status: number | undefined; body: string | undefined } = { status: undefined, body: undefined }
  return {
    writeHead(status: number) {
      observed.status = status
      return this
    },
    end(body?: string) {
      observed.body = body
      return this
    },
    get status() { return observed.status },
    get body() { return observed.body },
  } as unknown as ServerResponse & { status?: number; body?: string }
}

function fastRoute(registry?: FastModeRegistry, policy?: ImageToolPolicy): CapturedRoute {
  const route = routes(registry, policy).find(candidate => candidate.path === OPENAI_CODEX_FAST_MODE_PATH)
  if (route === undefined) throw new Error('Fast Mode route was not registered')
  return route
}

function bodyOf(responseValue: { body?: string }): unknown {
  return JSON.parse(responseValue.body ?? 'null') as unknown
}

describe('OpenAI Codex Fast Mode routes', () => {
  it('defaults off, isolates sessions, and disables by deletion', async () => {
    const registry = new FastModeRegistry()
    const route = fastRoute(registry)
    const initial = response()
    await route.handler(request({ method: 'GET', url: `${OPENAI_CODEX_FAST_MODE_PATH}?sessionId=a` }), initial)
    expect(initial.status).toBe(200)
    expect(bodyOf(initial)).toEqual({ enabled: false })

    const enabled = response()
    await route.handler(request({
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ sessionId: 'a', enabled: true }),
    }), enabled)
    expect(enabled.status).toBe(200)
    expect(bodyOf(enabled)).toEqual({ enabled: true })

    const other = response()
    await route.handler(request({ method: 'GET', url: `${OPENAI_CODEX_FAST_MODE_PATH}?sessionId=b` }), other)
    expect(bodyOf(other)).toEqual({ enabled: false })

    const disabled = response()
    await route.handler(request({
      method: 'POST',
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ sessionId: 'a', enabled: false }),
    }), disabled)
    expect(bodyOf(disabled)).toEqual({ enabled: false })
    expect(registry.size).toBe(0)
  })

  it('fails closed for origin, method, content type, input, and bounded body', async () => {
    const route = fastRoute()
    const remote = response()
    await route.handler(request({
      method: 'GET',
      url: `${OPENAI_CODEX_FAST_MODE_PATH}?sessionId=secret-session`,
      remoteAddress: '192.168.1.8',
      origin: 'http://192.168.1.20:3081',
    }), remote)
    expect(remote.status).toBe(403)
    expect(JSON.stringify(bodyOf(remote))).not.toContain('secret-session')

    const method = response()
    await route.handler(request({ method: 'PUT' }), method)
    expect(method.status).toBe(405)

    const type = response()
    await route.handler(request({ method: 'POST', contentType: 'text/plain', body: '{}' }), type)
    expect(type.status).toBe(415)

    const input = response()
    await route.handler(request({ method: 'POST', contentType: 'application/json', body: JSON.stringify({ sessionId: '', enabled: true }) }), input)
    expect(input.status).toBe(400)

    const oversized = response()
    await route.handler(request({ method: 'POST', contentType: 'application/json', body: 'x'.repeat(4_097) }), oversized)
    expect(oversized.status).toBe(413)
  })
})

describe('OpenAI Codex Fast Mode default preference', () => {
  it('reports enabled for any session while the default is forced on', async () => {
    const registry = new FastModeRegistry()
    const policy = {
      fastModeSnapshot: () => ({ fastModeDefault: true }),
    } as unknown as ImageToolPolicy
    const route = fastRoute(registry, policy)

    const forced = response()
    await route.handler(request({ method: 'GET', url: `${OPENAI_CODEX_FAST_MODE_PATH}?sessionId=never-registered` }), forced)
    expect(forced.status).toBe(200)
    expect(bodyOf(forced)).toEqual({ enabled: true })

    const posted = response()
    await route.handler(request({
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({ sessionId: 'a', enabled: false }),
    }), posted)
    expect(posted.status).toBe(200)
    expect(bodyOf(posted)).toEqual({ enabled: false })
    expect(registry.size).toBe(0)

    registry.set('a', true)
    const stillForced = response()
    await route.handler(request({ method: 'GET', url: `${OPENAI_CODEX_FAST_MODE_PATH}?sessionId=a` }), stillForced)
    expect(bodyOf(stillForced)).toEqual({ enabled: true })
  })

  it('serves and updates the Fast Mode default through its settings route', async () => {
    let fastModeDefault = false
    const policy = {
      fastModeSnapshot: vi.fn(() => ({ fastModeDefault })),
      updateFastMode: vi.fn(async (patch: { fastModeDefault?: boolean }) => {
        if (patch.fastModeDefault !== undefined) fastModeDefault = patch.fastModeDefault
        return { fastModeDefault }
      }),
    } as unknown as ImageToolPolicy
    const route = routes(new FastModeRegistry(), policy)
      .find(candidate => candidate.path === OPENAI_CODEX_FAST_MODE_SETTINGS_PATH)
    if (route === undefined) throw new Error('Fast Mode settings route was not registered')

    const getResponse = response()
    await route.handler(request({ method: 'GET', url: OPENAI_CODEX_FAST_MODE_SETTINGS_PATH }), getResponse)
    expect(getResponse.status).toBe(200)
    expect(bodyOf(getResponse)).toEqual({ fastModeDefault: false })

    const postResponse = response()
    await route.handler(request({
      method: 'POST',
      url: OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
      contentType: 'application/json',
      body: JSON.stringify({ fastModeDefault: true }),
    }), postResponse)
    expect(postResponse.status).toBe(200)
    expect(policy.updateFastMode).toHaveBeenCalledWith({ fastModeDefault: true })
    expect(bodyOf(postResponse)).toEqual({ fastModeDefault: true })

    const invalidResponse = response()
    await route.handler(request({
      method: 'POST',
      url: OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
      contentType: 'application/json',
      body: JSON.stringify({ fastModeDefault: 'yes' }),
    }), invalidResponse)
    expect(invalidResponse.status).toBe(400)

    const unknownResponse = response()
    await route.handler(request({
      method: 'POST',
      url: OPENAI_CODEX_FAST_MODE_SETTINGS_PATH,
      contentType: 'application/json',
      body: JSON.stringify({ unknown: true }),
    }), unknownResponse)
    expect(unknownResponse.status).toBe(400)
  })
})
