import type { OAuthCredential } from '@earendil-works/pi-ai'

type JsonObject = Record<string, unknown>
export interface CredentialDocument {
  credential: OAuthCredential | undefined
  update(value: OAuthCredential | undefined): JsonObject
}

function object(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function claims(token: unknown): JsonObject {
  if (typeof token !== 'string') return {}
  try {
    const value: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    return object(value) ? value : {}
  } catch { return {} }
}

/** Recognize supported schemas, never arbitrary token-looking fields. */
export function decodeCredentialDocument(text: string): CredentialDocument {
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('openai-codex: credential file is not valid JSON') }
  if (!object(parsed)) throw new Error('openai-codex: credential file must contain an object')
  const root = parsed
  const matches: { kind: string; key?: string; value: JsonObject }[] = []
  if (root.version === 1 && object(root.credential)) matches.push({ kind: 'dsh', key: 'credential', value: root.credential })
  if (object(root.tokens) && ('refresh_token' in root.tokens || root.auth_mode === 'chatgpt'))
    matches.push({ kind: 'codex', key: 'tokens', value: root.tokens })
  if (root.type === 'codex') matches.push({ kind: 'cpa', value: root })
  if (root.type === 'oauth') matches.push({ kind: 'oauth', value: root })
  for (const key of ['openai-codex', 'openai']) {
    const value = root[key]
    if (object(value) && value.type === 'oauth') matches.push({ kind: 'oauth', key, value })
  }
  if (matches.length !== 1) throw new Error('openai-codex: unsupported or ambiguous credential JSON format')
  const match = matches[0]!
  const snake = match.kind === 'codex' || match.kind === 'cpa'
  const value = match.value
  const allowed = match.kind === 'codex'
    ? ['access_token', 'refresh_token', 'account_id', 'id_token']
    : match.kind === 'cpa'
      ? ['type', 'access_token', 'refresh_token', 'account_id', 'id_token', 'expired', 'last_refresh', 'email', 'disabled', 'proxy_url', 'prefix']
      : ['type', 'access', 'refresh', 'expires', 'accountId', 'idToken', 'email', 'enterpriseUrl']
  const rejectUnknown = (fields: JsonObject, names: readonly string[]) => {
    const unknown = Object.keys(fields).find(key => !names.includes(key))
    if (unknown !== undefined) throw new Error(`openai-codex: unsupported credential field ${JSON.stringify(unknown)}`)
  }
  rejectUnknown(value, allowed)
  if (match.kind === 'codex') rejectUnknown(root, ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'])
  if (match.kind === 'dsh') rejectUnknown(root, ['version', 'credential'])
  for (const key of ['id_token', 'idToken', 'email', 'enterpriseUrl', 'proxy_url', 'prefix', 'last_refresh', 'expired']) {
    if (key in value && typeof value[key] !== 'string')
      throw new Error(`openai-codex: invalid credential field ${key}`)
  }
  if ('disabled' in value && typeof value.disabled !== 'boolean') throw new Error('openai-codex: invalid credential field disabled')
  if (!snake && value.type !== 'oauth') throw new Error('openai-codex: credential type must be oauth')
  const access = value[snake ? 'access_token' : 'access']
  const refresh = value[snake ? 'refresh_token' : 'refresh']
  const jwt = claims(access)
  const auth = jwt['https://api.openai.com/auth']
  const accountId = value[snake ? 'account_id' : 'accountId'] ?? (object(auth) ? auth.chatgpt_account_id : undefined)
  const expires = match.kind === 'codex'
    ? (typeof jwt.exp === 'number' ? jwt.exp * 1000 : NaN)
    : match.kind === 'cpa' ? Date.parse(String(value.expired)) : value.expires
  let credential: OAuthCredential | undefined
  if (!(access === '' && refresh === '')) {
    if (typeof access !== 'string' || !access) throw new Error('openai-codex: invalid credential access token')
    if (typeof refresh !== 'string' || !refresh) throw new Error('openai-codex: invalid credential refresh token')
    if (typeof accountId !== 'string' || !accountId) throw new Error('openai-codex: missing credential accountId')
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires < 0)
      throw new Error('openai-codex: invalid credential expiry')
    credential = { type: 'oauth', access, refresh, expires, accountId }
    const idToken = value[snake ? 'id_token' : 'idToken']
    if (typeof idToken === 'string' && idToken) credential.idToken = idToken
    if (typeof value.email === 'string' && value.email) credential.email = value.email
  }
  return {
    credential,
    update(next) {
      if (next && credential && credential.idToken && !next.idToken && next.accountId !== credential.accountId)
        throw new Error('openai-codex: account change requires a new ID token')
      const updated = { ...value }
      if (snake) {
        updated.access_token = next?.access ?? ''
        updated.refresh_token = next?.refresh ?? ''
        updated.account_id = next?.accountId ?? ''
        if (next?.idToken) updated.id_token = next.idToken
        else if (!next) updated.id_token = ''
        if ('email' in updated) updated.email = next?.email ?? (next?.accountId === credential?.accountId ? updated.email : '')
        if (match.kind === 'cpa') {
          updated.expired = new Date(next?.expires ?? 0).toISOString()
          updated.last_refresh = new Date().toISOString()
        }
      } else {
        Object.assign(updated, { type: 'oauth', access: next?.access ?? '', refresh: next?.refresh ?? '', expires: next?.expires ?? 0, accountId: next?.accountId ?? '' })
        if (next?.idToken) updated.idToken = next.idToken
        else if (!next) delete updated.idToken
        if (next?.email) updated.email = next.email
        else if (!next || next.accountId !== credential?.accountId) delete updated.email
      }
      const result = match.key ? { ...root, [match.key]: updated } : updated
      if (match.kind === 'codex') result.last_refresh = new Date().toISOString()
      return result
    },
  }
}
