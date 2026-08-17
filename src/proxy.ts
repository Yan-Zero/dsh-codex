/**
 * Global proxy injection for OpenAI Codex network traffic.
 *
 * This plugin and the pi-ai SDK it depends on both use the global fetch,
 * and Node's built-in fetch does not read HTTP(S)_PROXY environment
 * variables. Installing an undici global dispatcher once per process routes
 * every fetch in this process - including the OAuth token exchange performed
 * inside pi-ai - through the configured proxy without touching pi-ai.
 *
 * Calling installGlobalProxy again with a different URL replaces the
 * dispatcher, so Settings changes apply without restarting dsh.
 */

import { EnvHttpProxyAgent, ProxyAgent, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'

let currentKey: string | undefined

function createDispatcher(proxyUrl: string): Dispatcher {
  const url = new URL(proxyUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      'Unsupported proxy protocol ' + JSON.stringify(url.protocol) + '; use an http:// or https:// proxy URL (e.g. http://127.0.0.1:7890)',
    )
  }
  return new ProxyAgent(proxyUrl)
}

/**
 * Apply the process-wide proxy dispatcher.
 *
 * Resolution order: explicit proxyUrl (bundle config or Settings) >
 * DSH_HTTPS_PROXY environment variable > standard HTTPS_PROXY /
 * HTTP_PROXY / ALL_PROXY (handled by EnvHttpProxyAgent, which also
 * honors NO_PROXY). Re-invoking with an unchanged source is a no-op.
 * An invalid URL logs a warning and leaves the previous dispatcher active.
 */
export function installGlobalProxy(proxyUrl?: string): void {
  const env = process.env
  const explicit = proxyUrl?.trim()
  const dshProxy = env.DSH_HTTPS_PROXY?.trim()
  const key = explicit || dshProxy || (env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY ? 'env' : '')
  if (key === '') return
  if (key === currentKey) return
  let dispatcher: Dispatcher
  try {
    const chosen = explicit || dshProxy
    dispatcher = chosen ? createDispatcher(chosen) : new EnvHttpProxyAgent()
  } catch (error) {
    console.error('[dsh-codex] invalid proxy configuration ignored: ' + (error instanceof Error ? error.message : String(error)))
    return
  }
  setGlobalDispatcher(dispatcher)
  currentKey = key
}
