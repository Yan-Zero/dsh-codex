import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocked = vi.hoisted(() => ({
  diagnose: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  authPath: vi.fn(() => '/Users/fixture/.dsh/openai-codex-auth.json'),
  authStatus: vi.fn(),
  repairSessions: vi.fn(),
}))

vi.mock('../src/session-repair.ts', () => ({
  repairOpenAICodexSessions: mocked.repairSessions,
}))

vi.mock('../src/index.ts', () => ({
  diagnoseOpenAICodex: mocked.diagnose,
  loginOpenAICodex: mocked.login,
  logoutOpenAICodex: mocked.logout,
  openAICodexAuthPath: mocked.authPath,
  openAICodexAuthStatus: mocked.authStatus,
}))

import { run } from '../src/bin.ts'

let root: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('dsh-codex CLI', () => {
  it('trusts, lists, and untrusts exact origins through the server CLI', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-codex-bin-'))
    vi.stubEnv('DSH_HOME', root)
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })

    await expect(run(['trust-origin', 'HTTP://LAN.example:80/'])).resolves.toBe(0)
    expect(output).toContain('Trusted browser origin: http://lan.example')
    output = ''
    await expect(run(['trust-origin', 'http://lan.example'])).resolves.toBe(0)
    await expect(run(['trusted-origins'])).resolves.toBe(0)
    expect(output).toContain('http://lan.example')
    output = ''
    await expect(run(['untrust-origin', 'http://lan.example'])).resolves.toBe(0)
    output = ''
    await expect(run(['trusted-origins', '--json'])).resolves.toBe(0)
    expect(JSON.parse(output)).toEqual({ schemaVersion: 1, origins: [] })
    await expect(readFile(join(root, '.openai-codex-trusted-origins.json'), 'utf8')).resolves.toContain('origins')
  })

  it('documents doctor and uses the package executable name', async () => {
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })
    await expect(run(['--help'])).resolves.toBe(0)
    expect(output).toContain('dsh plugin --profile <name> exec dsh-codex <doctor|login|logout|status>')
    expect(output).toContain('exec dsh-codex trust-origin <origin>')
    expect(output).toContain('exec dsh-codex trusted-origins [--json]')
    expect(output).toContain('exec dsh-codex repair-session [file-or-directory] [--apply] [--json]')
    expect(output).toContain('doctor         inspect secret-free')
  })

  it('uses a consistent error prefix', async () => {
    let output = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })
    await expect(run(['doctor', '--device-code'])).resolves.toBe(1)
    expect(output).toMatch(/^dsh-codex:/)
    expect(output).not.toContain('dsh-codex-connect:')
  })

  it('previews the default tree and explicitly applies a selected Session path', async () => {
    mocked.repairSessions.mockImplementation(async (root: string | undefined, applied: boolean) => ({
      root: root ?? '/home/.dsh/sessions',
      mode: root === undefined ? 'directory' : 'file',
      applied,
      scannedSessions: root === undefined ? 12 : 1,
      currentSessions: root === undefined ? 8 : 0,
      unaffectedSessions: root === undefined ? 3 : 0,
      matchedSessions: 1,
      repairedEvents: 2,
      results: [{
        source: root ?? '/home/.dsh/sessions/project/session.jsonl.zstd',
        target: '/sessions/session.v3.jsonl.zstd',
        sourceVersion: 0,
        targetVersion: 3,
        sessionId: 'session-1',
        repairedEvents: 2,
        applied,
      }],
      failures: [],
    }))
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })

    await expect(run(['repair-session'])).resolves.toBe(0)
    expect(mocked.repairSessions).toHaveBeenLastCalledWith(undefined, false)
    expect(output).toContain('Repair preview: scanned 12 Session(s); 1 matched, 2 retired event(s)')
    output = ''
    await expect(run(['repair-session', '/sessions/session.jsonl.zstd', '--apply', '--json'])).resolves.toBe(0)
    expect(mocked.repairSessions).toHaveBeenLastCalledWith('/sessions/session.jsonl.zstd', true)
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, applied: true, repairedEvents: 2 })
  })

  it('emits one secret-free JSON document for doctor', async () => {
    const credentialPath = '/Users/fixture/.dsh/openai-codex-auth.json'
    mocked.diagnose.mockResolvedValue({
      package: 'dsh-codex',
      version: '0.1.0-alpha.4.8',
      node: 'v22.19.0',
      credentialFile: { path: credentialPath, state: 'owner-only', mode: '600' },
      capabilities: {
        modelProvider: true,
        search: false,
        imageTool: false,
        changesHarnessDefaultModel: false,
        changesHarnessSearchRoute: false,
      },
      providerConflict: false,
      compatibility: {
        schemaVersion: 1,
        status: 'compatible',
        node: { supported: '^22.19.0 || >=24.0.0', installed: 'v22.19.0', status: 'compatible' },
        packages: {
          '@deepseek-ai/dsh-llm': { supported: '0.1.7-rc.2', installed: '0.1.7-rc.2', status: 'compatible' },
          '@deepseek-ai/dsh-llm-pi-ai': { supported: '0.1.7-rc.2', installed: '0.1.7-rc.2', status: 'compatible' },
          '@earendil-works/pi-ai': { supported: '0.85.1', installed: '0.85.1', status: 'compatible' },
        },
      },
      hints: ['Safe diagnostic hint'],
    })
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })

    await expect(run(['doctor', '--json'])).resolves.toBe(0)
    const parsed: unknown = JSON.parse(output)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      package: 'dsh-codex',
      version: '0.1.0-alpha.4.8',
      node: 'v22.19.0',
      credentialFile: { state: 'owner-only', mode: '600' },
      capabilities: {
        modelProvider: true,
        search: false,
        imageTool: false,
        changesHarnessDefaultModel: false,
        changesHarnessSearchRoute: false,
      },
      providerConflict: false,
      hints: ['Safe diagnostic hint'],
    })
    expect(parsed).not.toHaveProperty('credentialFile.path')
    expect(parsed).toMatchObject({ compatibility: { schemaVersion: 1, status: 'compatible' } })
    for (const secret of [
      credentialPath,
      'https://auth.openai.com/oauth/authorize?fixture=secret',
      'fixture-access-token',
      'fixture-refresh-token',
      'fixture-account-id',
      '2099-01-01T00:00:00.000Z',
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  it('returns exit 1 and a JSON compatibility status for an incompatible doctor report', async () => {
    mocked.diagnose.mockResolvedValue({
      package: 'dsh-codex',
      version: '0.1.0-alpha.4.8',
      node: 'v22.19.0',
      credentialFile: { path: '/Users/fixture/.dsh/openai-codex-auth.json', state: 'missing' },
      capabilities: {
        modelProvider: true,
        search: false,
        imageTool: false,
        changesHarnessDefaultModel: false,
        changesHarnessSearchRoute: false,
      },
      providerConflict: false,
      compatibility: {
        schemaVersion: 1,
        status: 'incompatible',
        node: { supported: '^22.19.0 || >=24.0.0', installed: 'v22.19.0', status: 'compatible' },
        packages: {
          '@deepseek-ai/dsh-llm': { supported: '0.1.7-rc.2', installed: '0.1.0-rc.6', status: 'incompatible' },
          '@deepseek-ai/dsh-llm-pi-ai': { supported: '0.1.7-rc.2', installed: '0.1.0-rc.6', status: 'incompatible' },
          '@earendil-works/pi-ai': { supported: '0.85.1', installed: '0.84.4', status: 'incompatible' },
        },
      },
      hints: ['Compatibility mismatch'],
    })
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })
    await expect(run(['doctor', '--json'])).resolves.toBe(1)
    expect(JSON.parse(output)).toMatchObject({ compatibility: { status: 'incompatible' } })
    expect(output).not.toContain('/Users/fixture')
  })

  it.each([
    [true, 'signed-in', 0],
    [false, 'signed-out', 1],
  ] as const)('emits secret-free JSON status for %s authentication', async (authenticated, expectedStatus, expectedCode) => {
    mocked.authStatus.mockResolvedValue({
      authenticated,
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
      accountId: 'fixture-account-id',
      access: 'fixture-access-token',
      refresh: 'fixture-refresh-token',
    })
    let output = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })

    await expect(run(['status', '--json'])).resolves.toBe(expectedCode)
    const parsed: unknown = JSON.parse(output)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      package: 'dsh-codex',
      status: expectedStatus,
    })
    expect(parsed).not.toHaveProperty('expiresAt')
    expect(parsed).not.toHaveProperty('accountId')
    expect(parsed).not.toHaveProperty('access')
    expect(parsed).not.toHaveProperty('refresh')
    for (const secret of [
      'fixture-account-id',
      'fixture-access-token',
      'fixture-refresh-token',
      '2099-01-01T00:00:00.000Z',
    ]) {
      expect(output).not.toContain(secret)
    }
  })

  it.each([
    ['login', '--json'],
    ['logout', '--json'],
    ['doctor', '--device-code'],
    ['status', '--device-code'],
    ['login', '--device-code', '--json'],
    ['status', '--apply'],
  ] as const)('rejects unsupported flags for %s', async (...argv) => {
    let output = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      output += String(chunk)
      return true
    })

    await expect(run(argv)).resolves.toBe(1)
    expect(output).toMatch(/^dsh-codex: invalid options for /)
  })
})
