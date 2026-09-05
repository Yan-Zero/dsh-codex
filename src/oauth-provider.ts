import type { OAuthCredential } from '@earendil-works/pi-ai'
import { openaiCodexProvider as piOpenaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { createOpenAICodexProvider } from './provider.ts'

// Match pi-ai 0.84.4's Codex OAuth client and refresh grant. Keep login UI,
// cancellation, auth resolution and expiry scheduling owned by pi-ai.
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'

function claims(token: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { /* Report only a non-secret validation error below. */ }
  return {}
}

/** Full token response, unlike pi-ai's projection which discards id_token. */
export async function refreshOpenAICodexCredential(
  credential: OAuthCredential,
  signal: AbortSignal,
  requestFetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<OAuthCredential> {
  signal.throwIfAborted()
  const response = await requestFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: CLIENT_ID }),
    redirect: 'error',
    signal,
  })
  // Never include the token endpoint's response body in diagnostics.
  if (!response.ok) throw new Error(`OpenAI Codex token refresh failed (${response.status})`)
  let raw: unknown
  try { raw = await response.json() } catch { throw new Error('OpenAI Codex token refresh returned invalid JSON') }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('OpenAI Codex token refresh returned invalid fields')
  const data = raw as Record<string, unknown>
  for (const key of ['access_token', 'refresh_token', 'id_token']) {
    if (typeof data[key] !== 'string' || !data[key]) throw new Error(`OpenAI Codex token refresh missing ${key}`)
  }
  if (typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0)
    throw new Error('OpenAI Codex token refresh returned invalid expiry')
  const access = data.access_token as string
  const idToken = data.id_token as string
  const identity = claims(access)['https://api.openai.com/auth']
  const accountId = identity && typeof identity === 'object' ? (identity as Record<string, unknown>).chatgpt_account_id : undefined
  const idClaims = claims(idToken)
  const idAuth = idClaims['https://api.openai.com/auth']
  const idAccount = idAuth && typeof idAuth === 'object' ? (idAuth as Record<string, unknown>).chatgpt_account_id : undefined
  if (typeof accountId !== 'string' || !accountId || (idAccount !== undefined && idAccount !== accountId))
    throw new Error('OpenAI Codex token refresh returned inconsistent account identity')
  return {
    type: 'oauth', access, refresh: data.refresh_token as string,
    expires: Date.now() + data.expires_in * 1000, accountId, idToken,
    ...(typeof idClaims.email === 'string' ? { email: idClaims.email } : {}),
  }
}

/** Provider-local OAuth override: no global fetch hook or dependency mutation. */
export function openaiCodexProvider(requestFetch?: typeof globalThis.fetch): ReturnType<typeof piOpenaiCodexProvider> {
  const provider = createOpenAICodexProvider()
  const oauth = provider.auth.oauth!
  return {
    ...provider,
    auth: {
      ...provider.auth,
      oauth: {
        ...oauth,
        refresh: (credential, signal) => refreshOpenAICodexCredential(credential, signal, requestFetch),
        async login(interaction) {
          const credential = await oauth.login(interaction)
          // pi-ai's code exchange also drops id_token. One refresh obtains the
          // complete set before Models.login persists anything to the store.
          return refreshOpenAICodexCredential(credential, AbortSignal.any([
            interaction.signal, AbortSignal.timeout(15_000),
          ]), requestFetch)
        },
      },
    },
  }
}
