/** UI-independent implementation of the standard Codex command resource. */

import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import type { CommandHandler, CommandHandlerContext } from '@dsh-std/command'
import {
  externalRedirectSupport,
  type ExternalRedirectClient,
  type PresentationClients,
} from '@dsh-std/presentation'
import type { OpenAICodexService } from './service.ts'
import type { OpenAICodexUsage } from './usage.ts'

const HELP = [
  'Usage: /codex <status|login|logout|usage|config|set>',
  '  /codex status',
  '  /codex login [browser|device]',
  '  /codex logout',
  '  /codex usage',
  '  /codex config',
  '  /codex set <read-image|imagegen-other-models|websocket-context|native-compaction> <on|off>',
].join('\n')

type Result = Awaited<ReturnType<CommandHandler['execute']>>
type LoginState = { status: 'idle' } | { status: 'signing-in' } | { status: 'error'; message: string }

const OPENAI_CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback'

function success(text: string): Result { return { kind: 'success', text } }
function failure(text: string): Result { return { kind: 'error', text } }

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 1000)
}

function waitForPromptAbort(prompt: AuthPrompt): Promise<string> {
  const signal = prompt.signal
  if (signal === undefined) return new Promise<string>(() => {})
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  })
}

function redirectUrl(query: Readonly<Record<string, readonly string[]>>): string {
  const url = new URL(OPENAI_CODEX_REDIRECT_URI)
  for (const [name, values] of Object.entries(query)) {
    for (const value of values) url.searchParams.append(name, value)
  }
  return url.href
}

function supportsExternalRedirect(presentation: PresentationClients | undefined): boolean {
  return presentation?.descriptor.contracts.some(contract =>
    contract.apiVersion === externalRedirectSupport.apiVersion
      && contract.kind === externalRedirectSupport.kind) ?? false
}

class LoginController {
  private stateValue: LoginState = { status: 'idle' }
  private operation: Promise<void> | undefined
  private cancellation: AbortController | undefined
  private challenge: Promise<string> | undefined
  private resolveChallenge: ((message: string) => void) | undefined
  private rejectChallenge: ((error: unknown) => void) | undefined
  private manualCode: Promise<string> | undefined
  private resolveManualCode: ((value: string) => void) | undefined

  constructor(readonly service: OpenAICodexService) {}
  state(): LoginState { return this.stateValue }

  async start(method: 'browser' | 'device_code', presentation: PresentationClients | undefined): Promise<string> {
    if ((await this.service.authStatus()).authenticated) return 'OpenAI Codex is already signed in.'
    if (this.operation === undefined) this.begin(method, presentation)
    if (this.challenge === undefined) throw new Error('OpenAI Codex sign-in did not create an authorization challenge')
    const operation = this.operation
    const challenge = await this.challenge
    if (method === 'browser' && operation !== undefined) {
      // ExternalRedirect is invocation-scoped, so keep the command invocation
      // alive until the redirect has been handed to pi-ai and token exchange ends.
      await operation
      return 'OpenAI Codex sign-in complete.'
    }
    return challenge
  }

  async logout(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex sign-in cancelled'))
    await this.operation?.catch(() => undefined)
    await this.service.logout()
    this.stateValue = { status: 'idle' }
  }

  async dispose(): Promise<void> {
    this.cancellation?.abort(new Error('OpenAI Codex command disposed'))
    await this.operation?.catch(() => undefined)
  }

  private begin(method: 'browser' | 'device_code', presentation: PresentationClients | undefined): void {
    const cancellation = new AbortController()
    this.cancellation = cancellation
    this.stateValue = { status: 'signing-in' }
    this.challenge = new Promise<string>((resolve, reject) => {
      this.resolveChallenge = resolve
      this.rejectChallenge = reject
    })
    this.manualCode = method === 'browser'
      ? new Promise<string>(resolve => { this.resolveManualCode = resolve })
      : undefined
    let notifications = Promise.resolve()
    this.operation = this.service.login({
      signal: cancellation.signal,
      prompt: prompt => {
        if (prompt.type === 'select') return Promise.resolve(method)
        if (prompt.type === 'manual_code' && this.manualCode !== undefined) {
          return Promise.race([this.manualCode, waitForPromptAbort(prompt)])
        }
        return waitForPromptAbort(prompt)
      },
      notify: event => { notifications = notifications.then(() => this.onEvent(event, presentation)) },
    }).then(
      async () => { await notifications; this.stateValue = { status: 'idle' } },
      async (error: unknown) => {
        await notifications.catch(() => undefined)
        this.stateValue = { status: 'error', message: safeMessage(error) }
        this.rejectChallenge?.(error)
      },
    ).finally(() => {
      this.operation = undefined
      this.cancellation = undefined
      this.resolveChallenge = undefined
      this.rejectChallenge = undefined
      this.manualCode = undefined
      this.resolveManualCode = undefined
    })
  }

  private async onEvent(event: AuthEvent, presentation: PresentationClients | undefined): Promise<void> {
    if (event.type === 'device_code') {
      this.resolveChallenge?.(`Open ${event.verificationUri}\nEnter code: ${event.userCode}\nUse /codex status after approval.`)
      return
    }
    if (event.type !== 'auth_url') return
    try {
      const signal = this.cancellation?.signal
      const redirect = presentation?.externalRedirect?.receive(
        { exactRedirectUri: OPENAI_CODEX_REDIRECT_URI },
        signal === undefined ? undefined : { signal },
      )
      let receiverReady = false
      let callback: Awaited<ReturnType<ExternalRedirectClient['receive']>['result']> | undefined
      if (redirect !== undefined) {
        const first = await Promise.race([
          redirect.ready.then(() => ({ kind: 'ready' as const })),
          redirect.result.then(result => ({ kind: 'result' as const, result })),
        ])
        if (first.kind === 'ready') receiverReady = true
        else callback = first.result
      }
      const result = await presentation?.openExternal?.openExternal(
        { uri: event.url },
        signal === undefined ? undefined : { signal },
      )
      this.resolveChallenge?.(result?.status === 'submitted'
        ? 'Opened the ChatGPT authorization page. Use /codex status after approval.'
        : `Open this ChatGPT authorization page: ${event.url}\nUse /codex status after approval.`)
      if (redirect === undefined) return
      callback ??= await redirect.result
      if (callback.status === 'submitted') {
        this.resolveManualCode?.(redirectUrl(callback.value.query))
        return
      }
      // If the exact address was already occupied, pi-ai's own local listener is
      // still the authoritative fallback. Once the presentation-side receiver
      // announced readiness, however, losing it makes this browser flow terminal.
      if (receiverReady) throw new Error(`Browser callback receiver ${callback.status}`)
    } catch (error: unknown) {
      this.cancellation?.abort(error)
      this.rejectChallenge?.(error)
    }
  }
}

function formatExpiry(expiresAt: Date | undefined): string {
  return expiresAt === undefined || Number.isNaN(expiresAt.valueOf())
    ? ''
    : ` Access token expires ${expiresAt.toISOString()}; refresh is automatic.`
}

function formatWindowDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`
  if (seconds % 60 === 0) return `${seconds / 60}min`
  return `${seconds}s`
}

function formatResetTimestamp(resetsAt: number | undefined): string {
  if (resetsAt === undefined) return ''
  const date = new Date(resetsAt * 1_000)
  const part = (value: number): string => String(value).padStart(2, '0')
  const offsetMinutes = -date.getTimezoneOffset()
  const offsetSign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteOffset = Math.abs(offsetMinutes)
  const offset = `${offsetSign}${part(Math.floor(absoluteOffset / 60))}:${part(absoluteOffset % 60)}`
  return ` · resets ${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`
    + `T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}${offset}`
}

function formatUsage(usage: OpenAICodexUsage): string {
  const lines: string[] = []
  for (const limit of usage.rateLimits) for (const window of limit.windows) {
    lines.push(`${limit.name ?? limit.id} (${formatWindowDuration(window.windowSeconds)}): `
      + `${window.remainingPercent.toFixed(1)}% remaining${formatResetTimestamp(window.resetsAt)}`)
  }
  if (usage.individualLimit !== undefined) {
    lines.push(`Individual limit: ${usage.individualLimit.remainingPercent.toFixed(1)}% remaining `
      + `(${usage.individualLimit.remaining}/${usage.individualLimit.limit})`
      + formatResetTimestamp(usage.individualLimit.resetsAt))
  }
  if (usage.credits !== undefined) lines.push(`Credits: ${usage.credits.unlimited ? 'unlimited' : usage.credits.balance ?? 'available'}`)
  return lines.length === 0 ? 'OpenAI Codex usage is currently unavailable.' : lines.join('\n')
}

function formatConfig(service: OpenAICodexService): string {
  const images = service.imagePreferences()
  const responses = service.responsePreferences()
  return [
    `read-image: ${images.modifyReadImage ? 'on' : 'off'}`,
    `imagegen-other-models: ${images.shareImagegenWithOtherModels ? 'on' : 'off'}`,
    `websocket-context: ${responses.useWebSocketContextReuse ? 'on' : 'off'}`,
    `native-compaction: ${responses.useNativeCompaction ? 'on' : 'off'}`,
  ].join('\n')
}

async function updateSetting(service: OpenAICodexService, key: string, enabled: boolean): Promise<void> {
  if (key === 'read-image') return void await service.updateImagePreferences({ modifyReadImage: enabled })
  if (key === 'imagegen-other-models') return void await service.updateImagePreferences({ shareImagegenWithOtherModels: enabled })
  if (key === 'websocket-context') return void await service.updateResponsePreferences({ useWebSocketContextReuse: enabled })
  if (key === 'native-compaction') return void await service.updateResponsePreferences({ useNativeCompaction: enabled })
  throw new Error(`unknown setting ${JSON.stringify(key)}`)
}

export class OpenAICodexCommand implements CommandHandler {
  private login: LoginController | undefined
  constructor(private readonly service: () => OpenAICodexService | undefined) {}

  async execute(input: { readonly rawInput: string }, context: CommandHandlerContext): Promise<Result> {
    const service = this.service()
    if (service === undefined) return failure('OpenAI Codex Runtime is unavailable.')
    if (this.login?.service !== service) {
      await this.login?.dispose()
      this.login = new LoginController(service)
    }
    const login = this.login
    const parts = input.rawInput.trim().split(/\s+/u).filter(Boolean)
    const action = parts[0] ?? 'status'
    try {
      if (action === 'status') {
        const state = login.state()
        if (state.status === 'signing-in') return success('OpenAI Codex sign-in is waiting for approval.')
        if (state.status === 'error') return failure(`OpenAI Codex sign-in failed: ${state.message}`)
        const status = await service.authStatus()
        return status.authenticated
          ? success(`OpenAI Codex is signed in.${formatExpiry(status.expiresAt)}`)
          : failure('OpenAI Codex is signed out. Run /codex login.')
      }
      if (action === 'login') {
        if (parts.length > 2 || (parts[1] !== undefined && parts[1] !== 'browser' && parts[1] !== 'device')) return failure(HELP)
        const method = parts[1] === 'device'
          ? 'device_code'
          : parts[1] === 'browser' || supportsExternalRedirect(context.presentation)
            ? 'browser'
            : 'device_code'
        return success(await login.start(method, context.presentation))
      }
      if (action === 'logout' && parts.length === 1) { await login.logout(); return success('OpenAI Codex is signed out.') }
      if (action === 'usage' && parts.length === 1) return success(formatUsage(await service.usage()))
      if (action === 'config' && parts.length === 1) return success(formatConfig(service))
      if (action === 'set' && parts.length === 3 && (parts[2] === 'on' || parts[2] === 'off')) {
        await updateSetting(service, parts[1] as string, parts[2] === 'on')
        return success(formatConfig(service))
      }
      return failure(HELP)
    } catch (error: unknown) {
      return failure(safeMessage(error))
    }
  }

  async dispose(): Promise<void> { await this.login?.dispose() }
}
