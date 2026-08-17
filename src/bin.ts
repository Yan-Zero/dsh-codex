#!/usr/bin/env node
/** Standalone credential CLI for the optional OpenAI Codex bundle. */

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import {
  loginOpenAICodex,
  logoutOpenAICodex,
  openAICodexAuthStatus,
} from './auth.ts'
import { openAICodexAuthPath } from './store.ts'

type Action = 'login' | 'logout' | 'status'

/** Open one trusted HTTPS URL with the platform browser, best effort. */
function openBrowser(rawUrl: string): void {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') throw new Error(`refusing to open non-HTTPS authorization URL from ${url.host}`)
  const command = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url.href] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url.href] }
      : { file: 'xdg-open', args: [url.href] }
  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The printed URL remains the manual fallback.
  }
}

/** Remove token-like strings from an external OAuth diagnostic. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
}

/** Render one provider event without exposing stored credentials. */
function notify(event: AuthEvent, useBrowser: boolean): void {
  switch (event.type) {
    case 'auth_url':
      process.stdout.write(`Open this URL to sign in:\n${event.url}\n`)
      if (event.instructions !== undefined) process.stdout.write(`${event.instructions}\n`)
      if (useBrowser) openBrowser(event.url)
      break
    case 'device_code':
      process.stdout.write(`Open this URL to sign in:\n${event.verificationUri}\nEnter code: ${event.userCode}\n`)
      if (useBrowser) openBrowser(event.verificationUri)
      break
    case 'info':
    case 'progress':
      process.stdout.write(`${event.message}\n`)
      break
    default:
      event satisfies never
  }
}

/** Answer a provider auth prompt through the terminal. */
async function answerPrompt(
  prompt: AuthPrompt,
  deviceCode: boolean,
  question: (text: string, options: { signal?: AbortSignal }) => Promise<string>,
): Promise<string> {
  if (prompt.type === 'select') {
    const wanted = deviceCode ? 'device_code' : 'browser'
    if (!prompt.options.some(option => option.id === wanted)) {
      throw new Error(`OpenAI Codex login did not offer the requested ${wanted} method`)
    }
    return wanted
  }
  const suffix = prompt.placeholder === undefined ? '' : ` (${prompt.placeholder})`
  return question(`${prompt.message}${suffix}: `, {
    ...prompt.signal === undefined ? {} : { signal: prompt.signal },
  })
}

/** Print the standalone command help. */
function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-openai-codex <login|logout|status> [--device-code]',
    '',
    '  login          sign in with a separate ChatGPT OAuth session',
    '  logout         remove the dsh credential without changing ~/.codex',
    '  status         report non-secret dsh credential state',
    '  --device-code  use headless device-code login (login only)',
    '',
  ].join('\n'))
}

/** Execute one boot-free credential command. */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }
  const [rawAction, ...flags] = argv
  if (rawAction !== 'login' && rawAction !== 'logout' && rawAction !== 'status') {
    process.stderr.write(`dsh-openai-codex: expected login, logout, or status; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action: Action = rawAction
  const unknown = flags.filter(flag => flag !== '--device-code')
  if (unknown.length > 0 || (flags.includes('--device-code') && action !== 'login')) {
    process.stderr.write(`dsh-openai-codex: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  try {
    switch (action) {
      case 'status': {
        const status = await openAICodexAuthStatus()
        if (!status.authenticated) {
          process.stdout.write('OpenAI Codex for dsh: signed out\n')
          return 1
        }
        const expires = status.expiresAt
        const suffix = expires === undefined || Number.isNaN(expires.valueOf())
          ? ''
          : `; access token expires ${expires.toISOString()} (refresh is automatic)`
        process.stdout.write(`OpenAI Codex for dsh: signed in${suffix}\n`)
        return 0
      }
      case 'logout':
        await logoutOpenAICodex()
        process.stdout.write(`OpenAI Codex for dsh: signed out; removed ${openAICodexAuthPath()}\n`)
        return 0
      case 'login': {
        const readline = createInterface({ input: process.stdin, output: process.stdout })
        try {
          await loginOpenAICodex({
            prompt: prompt => answerPrompt(prompt, flags.includes('--device-code'), (text, options) => readline.question(text, options)),
            notify: event => notify(event, true),
          })
        } finally {
          readline.close()
        }
        process.stdout.write(`OpenAI Codex for dsh: signed in; credentials saved to ${openAICodexAuthPath()}\n`)
        return 0
      }
    }
  } catch (error: unknown) {
    process.stderr.write(`dsh-openai-codex: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
