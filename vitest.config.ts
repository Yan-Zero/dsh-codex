import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const packageVersion = (JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }).version

export default defineConfig({
  define: {
    __CODEX_CONNECT_VERSION__: JSON.stringify(packageVersion),
  },
  test: {
    // Do not let a developer's installed Codex catalog affect bundled-model tests.
    env: { DSH_CODEX_MODELS_CACHE: fileURLToPath(new URL('./tests/fixtures/no-codex-cache.json', import.meta.url)) },
    include: ['tests/**/*.spec.{ts,tsx}'],
    testTimeout: 30_000,
  },
})
