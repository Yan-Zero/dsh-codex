/** Backend-only Codex usage analytics and live HUD routes. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { OpenAICodexService } from './service.ts'
import type { UsageFilters, UsageRange } from './usage-ledger.ts'

export const OPENAI_CODEX_ANALYTICS_BASE_PATH = '/plugins/dsh-openai-codex/usage'

const VALID_RANGES = new Set<UsageRange>(['today', '24h', '7d', 'this-week', '30d', '90d', 'all', 'custom'])

function trustedRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (host === undefined) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === new URL(`http://${host}`).host
  } catch {
    return false
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(value))
}

function filters(req: IncomingMessage): UsageFilters {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const requestedRange = url.searchParams.get('range') ?? '7d'
  if (!VALID_RANGES.has(requestedRange as UsageRange)) throw new Error('invalid range')
  const numeric = (name: string): number | undefined => {
    const raw = url.searchParams.get(name)
    if (raw === null) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid ${name}`)
    return value
  }
  const list = (name: string, lowercase = false): string[] | undefined => {
    const values = url.searchParams.getAll(name)
      .flatMap(value => value.split(','))
      .map(value => lowercase ? value.trim().toLowerCase() : value.trim())
      .filter(Boolean)
    return values.length === 0 ? undefined : [...new Set(values)]
  }
  const start = numeric('start')
  const end = numeric('end')
  const providers = list('provider')
  const models = list('model')
  const reasoning = list('reasoning', true)
  return {
    range: requestedRange as UsageRange,
    ...start === undefined ? {} : { start },
    ...end === undefined ? {} : { end },
    ...providers === undefined ? {} : { providers },
    ...models === undefined ? {} : { models },
    ...reasoning === undefined ? {} : { reasoning },
  }
}

function routePath(req: IncomingMessage): string {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500)
}

/** Register backend aggregations; no endpoint returns raw prompts, responses, or credentials. */
export function registerOpenAICodexUsageRoutes(ctx: Context, service: OpenAICodexService): void {
  const ledger = service.usageTracker.ledger
  ctx.effect(() => {
    const api = ctx.webServer.register({
      kind: 'prefix',
      path: OPENAI_CODEX_ANALYTICS_BASE_PATH,
      handler: async (req, res) => {
        if (!trustedRequest(req)) return json(res, 403, { error: 'forbidden' })
        const path = routePath(req).slice(OPENAI_CODEX_ANALYTICS_BASE_PATH.length) || '/summary'
        try {
          if (path === '/hud' && req.method === 'PUT') {
            const visible = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost')).searchParams.get('visible')
            if (visible !== '0' && visible !== '1') return json(res, 400, { error: 'visible must be 0 or 1' })
            return json(res, 200, await service.updateUsageUiPreferences({ showUsageHud: visible === '1' }))
          }
          if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
          if (path === '/events') {
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
            return
          }
          const query = filters(req)
          if (path === '/analytics') {
            const [summary, timeseries, providers, models, reasoning, tasks] = await Promise.all([
              ledger.summary(query),
              ledger.usageOverTime(query),
              ledger.breakdown('provider', query),
              ledger.breakdown('model', query),
              ledger.breakdown('reasoning_effort', query),
              ledger.tasks(query, 25),
            ])
            return json(res, 200, { summary, timeseries, providers, models, reasoning, tasks })
          }
          if (path === '/summary') return json(res, 200, await ledger.summary(query))
          if (path === '/timeseries') return json(res, 200, await ledger.usageOverTime(query))
          if (path === '/providers') return json(res, 200, await ledger.breakdown('provider', query))
          if (path === '/models') return json(res, 200, await ledger.breakdown('model', query))
          if (path === '/reasoning') return json(res, 200, await ledger.breakdown('reasoning_effort', query))
          if (path === '/tasks') return json(res, 200, await ledger.tasks(query))
          if (path === '/sessions') return json(res, 200, await ledger.sessions(query))
          if (path === '/current-session') {
            const sessionId = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost')).searchParams.get('sessionId')
            if (sessionId === null || sessionId === '') return json(res, 400, { error: 'sessionId is required' })
            return json(res, 200, {
              session: await ledger.sessionUsage(sessionId) ?? null,
              ...service.usageUiPreferences(),
            })
          }
          if (path === '/current-task') {
            return json(res, 200, {
              tracker: service.usageTracker.snapshot(),
              task: await service.usageTracker.currentTask() ?? null,
              hudVisible: service.usageUiPreferences().showUsageHud,
            })
          }
          if (path === '/hud') return json(res, 200, service.usageUiPreferences())
          if (path === '/quota') {
            let refreshError: string | undefined
            if (new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).searchParams.get('refresh') === '1') {
              await service.usage().catch((error: unknown) => { refreshError = safeMessage(error) })
            }
            return json(res, 200, { snapshots: await ledger.latestQuota(), ...refreshError === undefined ? {} : { refreshError } })
          }
          if (path === '/rates') return json(res, 200, await ledger.rateHistory())
          const taskPrefix = '/tasks/'
          if (path.startsWith(taskPrefix)) {
            const taskId = decodeURIComponent(path.slice(taskPrefix.length))
            const detail = await ledger.taskDetail(taskId)
            return detail === undefined ? json(res, 404, { error: 'task not found' }) : json(res, 200, detail)
          }
          return json(res, 404, { error: 'not found' })
        } catch (error: unknown) {
          return json(res, 400, { error: safeMessage(error) })
        }
      },
    })
    return () => { api() }
  }, 'dsh-openai-codex: usage analytics routes')
}
