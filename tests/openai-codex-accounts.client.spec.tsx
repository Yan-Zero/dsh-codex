// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OpenAICodexSettings } from '../src/client/OpenAICodexSettings.tsx'
import { en } from '../src/client/locales.ts'
import type { OpenAICodexSettingsKey } from '../src/client/locales.ts'
const t = (key: OpenAICodexSettingsKey) => en[key]
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function setup(stale?: Promise<Response>) {
  let overview = { selectedAccountId: 'default', autoSwitch: false, accounts: [{ id: 'default', name: 'Personal', authenticated: true }, { id: 'work', name: 'Work', authenticated: false }] }
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith('/accounts')) {
      const patch = init?.body ? JSON.parse(String(init.body)) : {}
      if (init?.method === 'POST') overview.accounts.push({ id: 'new', name: patch.name, authenticated: false })
      else {
        if (patch.selectedAccountId) overview.selectedAccountId = patch.selectedAccountId
        if (patch.autoSwitch !== undefined) overview.autoSwitch = patch.autoSwitch
        if (patch.accountId) overview.accounts = overview.accounts.map(a => a.id === patch.accountId ? { ...a, name: patch.name } : a)
      }
      return json(overview)
    }
    if (url.pathname.endsWith('/auth/local-status')) return json({ authenticated: false })
    if (url.pathname.endsWith('/auth/status')) {
      if (url.searchParams.get('accountId') === 'default' && stale) return stale
      return json({ status: 'signed-out' })
    }
    if (url.pathname.endsWith('/auth/device-login')) return json({ method: 'device_code', url: 'https://auth.openai.com/codex/device', code: 'TEST-CODE' })
    throw new Error('Unrelated preference request')
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OpenAICodexSettings t={t} />)
  return { fetchMock, selectExternally: (id: string) => { overview.selectedAccountId = id } }
}
it('persists selection, names, creation and optional automatic switching, and scopes login', async () => {
  const { fetchMock } = setup()
  const selector = await screen.findByRole<HTMLSelectElement>('combobox', { name: en.selectedAccount })
  await waitFor(() => expect(selector.value).toBe('default'))
  const toggle = screen.getByRole('switch', { name: en.autoSwitchAccounts })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  fireEvent.change(selector, { target: { value: 'work' } })
  await waitFor(() => expect(selector.value).toBe('work'))
  fireEvent.change(screen.getByRole('textbox', { name: en.accountName }), { target: { value: 'Team' } })
  fireEvent.click(screen.getByRole('button', { name: en.renameAccount }))
  await screen.findByRole('option', { name: 'Team' })
  fireEvent.change(screen.getByRole('textbox', { name: en.newAccountName }), { target: { value: 'Backup' } })
  fireEvent.click(screen.getByRole('button', { name: en.addAccount }))
  await waitFor(() => expect(selector.value).toBe('new'))
  fireEvent.click(await screen.findByRole('button', { name: en.loginDeviceCode }))
  await screen.findByText('TEST-CODE')
  expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/auth/device-login?accountId=new') && init?.method === 'POST')).toBe(true)
  fireEvent.change(selector, { target: { value: 'work' } })
  await waitFor(() => expect(selector.value).toBe('work'))
  await waitFor(() => expect(screen.queryByText('TEST-CODE')).toBeNull())
})
it('ignores a delayed quota response from the previously selected account', async () => {
  let resolve!: (value: Response) => void
  const pending = new Promise<Response>(r => { resolve = r })
  const { fetchMock } = setup(pending)
  const selector = await screen.findByRole<HTMLSelectElement>('combobox', { name: en.selectedAccount })
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/auth/status?accountId=default'))).toBe(true))
  fireEvent.change(selector, { target: { value: 'work' } })
  await waitFor(() => expect(selector.value).toBe('work'))
  await act(async () => resolve(json({ status: 'signed-in', usage: { rateLimits: [] } })))
  expect(screen.getByRole('status').textContent).toBe(en.signedOut)
  expect(screen.queryByRole('button', { name: en.logout })).toBeNull()
})

it('polls automatic account changes without overwriting an unsaved name', async () => {
  const intervals = vi.spyOn(window, 'setInterval')
  const { selectExternally } = setup()
  const selector = await screen.findByRole<HTMLSelectElement>('combobox', { name: en.selectedAccount })
  await waitFor(() => expect(selector.value).toBe('default'))
  const name = screen.getByRole<HTMLInputElement>('textbox', { name: en.accountName })
  fireEvent.change(name, { target: { value: 'Draft name' } })
  const poll = intervals.mock.calls.find(([, delay]) => delay === 10_000)?.[0] as () => void
  expect(poll).toBeTypeOf('function')
  await act(async () => { poll() })
  expect(name.value).toBe('Draft name')
  selectExternally('work')
  await act(async () => { poll() })
  await waitFor(() => expect(selector.value).toBe('work'))
  expect(name.value).toBe('Work')
})
