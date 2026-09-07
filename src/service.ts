/** Shared host service consumed by optional OpenAI Codex front-door adapters. */

import type { AuthInteraction } from '@earendil-works/pi-ai'
import type { Context } from '@deepseek-ai/cordis'
import { loginOpenAICodex, logoutOpenAICodex, openAICodexAuthStatus } from './auth.ts'
import type { OpenAICodexAuthStatus } from './auth.ts'
import { OpenAICodexCredentialStore } from './store.ts'
import { OpenAICodexAccounts } from './accounts.ts'
import { OpenAICodexProxyTransport } from './proxy.ts'
import type { ProxyPreferences } from './proxy.ts'
import { ImageToolPolicy } from './tool-policy.ts'
import type {
  ContextWindowPreferences,
  FastModePreferences,
  ImageToolPreferences,
  ModelCatalogEntry,
  ModelCatalogSettings,
  ResponseApiPreferences,
  UsageUiPreferences,
} from './tool-policy.ts'
import { readOpenAICodexRateLimits } from './usage.ts'
import type { OpenAICodexUsage } from './usage.ts'
import { CodexUsageLedger, CodexUsageTracker } from './usage-ledger.ts'
import type { QuotaSnapshot } from './usage-ledger.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Provider-owned account and preference service for optional front doors. */
    openAICodex: OpenAICodexService
  }
}

/** Initial settings contributed by the bundle configuration. */
export interface OpenAICodexServiceOptions
  extends ImageToolPreferences,
    ResponseApiPreferences,
    ContextWindowPreferences,
    FastModePreferences,
    ProxyPreferences {
  credentialFile?: string
  models?: string[]
  modelCatalog: readonly ModelCatalogEntry[] | (() => readonly ModelCatalogEntry[])
}

/**
 * One provider-owned host service shared by Web routes and terminal adapters.
 * Credentials and live policy stay singletons even when several front doors are mounted.
 */
export class OpenAICodexService {
  readonly accounts: OpenAICodexAccounts
  readonly credentials: OpenAICodexCredentialStore
  readonly policy: ImageToolPolicy
  readonly usageTracker = new CodexUsageTracker()
  readonly proxy: OpenAICodexProxyTransport
  private readonly stopProxyWatch: () => void
  private readonly accountQuotaLedgers = new Map<string, CodexUsageLedger>()

  constructor(options: OpenAICodexServiceOptions) {
    this.credentials = new OpenAICodexCredentialStore(options.credentialFile)
    this.accounts = new OpenAICodexAccounts(this.credentials)
    const { credentialFile: _credentialFile, modelCatalog, ...preferences } = options
    this.policy = new ImageToolPolicy(preferences, modelCatalog)
    this.proxy = new OpenAICodexProxyTransport(() => this.policy.proxySnapshot())
    void this.proxy.apply().catch((error: unknown) => {
      process.stderr.write(
        `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    })
    this.stopProxyWatch = this.policy.watchProxyPreferences(() => {
      void this.proxy.apply().catch((error: unknown) => {
        process.stderr.write(
          `[dsh-codex] failed to apply proxy settings: ${error instanceof Error ? error.message : String(error)}\n`,
        )
      })
    })
  }

  /** Attach the durable settings document when the active profile provides it. */
  attachSettings(ctx: Context): void {
    this.policy.attach(ctx)
  }

  /** Start the provider-native OAuth lifecycle. */
  async login(interaction: AuthInteraction): Promise<void> {
    await this.proxy.apply()
    return await loginOpenAICodex(interaction, await this.accounts.store(), this.proxy.fetch)
  }

  /** Clear the selected credential; explicit shared files affect their other consumers too. */
  async logout(): Promise<void> {
    return logoutOpenAICodex(await this.accounts.store())
  }

  /** Read non-secret authentication metadata. */
  async authStatus(): Promise<OpenAICodexAuthStatus & { accountId: string }> {
    const accountId = (await this.accounts.overview()).selectedAccountId
    return { ...await openAICodexAuthStatus(await this.accounts.store(accountId)), accountId }
  }

  /** Read current subscription limits without issuing a model request. */
  async usage(accountId?: string): Promise<OpenAICodexUsage> {
    const store = await this.accounts.store(accountId)
    const ledger = this.quotaLedger(store)
    const usage = await readOpenAICodexRateLimits(store, this.proxy.fetch)
    await ledger.saveQuota(usage)
    return usage
  }

  /** Quota caches follow the selected account; token analytics remain provider-wide. */
  async latestQuota(): Promise<QuotaSnapshot[]> {
    return this.quotaLedger(await this.accounts.store()).latestQuota()
  }

  private quotaLedger(store: OpenAICodexCredentialStore): CodexUsageLedger {
    if (store.filename === this.credentials.filename) return this.usageTracker.ledger
    let ledger = this.accountQuotaLedgers.get(store.filename)
    if (ledger === undefined) {
      ledger = new CodexUsageLedger(`${store.filename}.usage.sqlite3`)
      this.accountQuotaLedgers.set(store.filename, ledger)
    }
    return ledger
  }

  imagePreferences(): ImageToolPreferences {
    return this.policy.snapshot()
  }

  updateImagePreferences(patch: Partial<ImageToolPreferences>): Promise<ImageToolPreferences> {
    return this.policy.update(patch)
  }

  responsePreferences(): ResponseApiPreferences {
    return this.policy.responseApiSnapshot()
  }

  updateResponsePreferences(patch: Partial<ResponseApiPreferences>): Promise<ResponseApiPreferences> {
    return this.policy.updateResponseApi(patch)
  }

  usageUiPreferences(): UsageUiPreferences {
    return this.policy.usageUiSnapshot()
  }

  async updateUsageUiPreferences(patch: Partial<UsageUiPreferences>): Promise<UsageUiPreferences> {
    const next = await this.policy.updateUsageUi(patch)
    this.usageTracker.refresh()
    return next
  }

  contextWindowPreferences(): ContextWindowPreferences {
    return this.policy.contextWindowSnapshot()
  }

  updateContextWindowPreferences(
    patch: Partial<ContextWindowPreferences>,
  ): Promise<ContextWindowPreferences> {
    return this.policy.updateContextWindow(patch)
  }

  fastModePreferences(): FastModePreferences {
    return this.policy.fastModeSnapshot()
  }

  updateFastModePreferences(patch: Partial<FastModePreferences>): Promise<FastModePreferences> {
    return this.policy.updateFastMode(patch)
  }

  modelCatalogSettings(): ModelCatalogSettings {
    return this.policy.modelCatalogSnapshot()
  }

  proxyPreferences(): ProxyPreferences {
    return this.policy.proxySnapshot()
  }

  async updateProxyPreferences(patch: Partial<ProxyPreferences>): Promise<ProxyPreferences> {
    const preferences = await this.policy.updateProxy(patch)
    await this.proxy.apply()
    return preferences
  }

  async dispose(): Promise<void> {
    this.stopProxyWatch()
    await this.proxy.dispose()
    for (const ledger of this.accountQuotaLedgers.values()) ledger.close()
    this.accountQuotaLedgers.clear()
  }
}
