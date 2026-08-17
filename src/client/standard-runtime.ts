export type CodexRuntimeAvailability =
  | { readonly state: 'installed' }
  | { readonly state: 'not-installed'; readonly runtime: string }
  | { readonly state: 'unavailable'; readonly message: string }

const STATUS_PATH = '/plugins/dsh-openai-codex/auth/status'

/** Probe the component-owned backend route instead of an adapter-private inventory projection. */
export async function loadCodexRuntimeAvailability(
  request: typeof fetch = fetch,
  runtime = globalThis.location?.host || 'current Runtime',
): Promise<CodexRuntimeAvailability> {
  const response = await request(STATUS_PATH, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  })
  if (response.ok) return { state: 'installed' }
  if (response.status === 404) return { state: 'not-installed', runtime }
  return { state: 'unavailable', message: `HTTP ${response.status}` }
}
