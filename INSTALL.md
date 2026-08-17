# Installation

`dsh-codex` is discovered through its package-root Community v0.15 `dsh-plugin.json`. This experimental branch is installed from a built source checkout, not from the npm registry.

The build environment and target profile must already provide `@dsh-std/sdk`, `@dsh-std/command`, `@dsh-std/model`, and a Host capable of loading the declared facet. How those experimental standard packages are installed is outside this component's installation procedure.

Build the checkout, then link its absolute path into the profile:

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

The component neither installs nor configures the Host adapter. The Host discovers `dsh-plugin.json` from the linked profile dependency and imports `lib/standard.js`.

Sign in through the standard command exposed by the active client:

```text
/codex login
```

The standalone credential command can also be run through the package executable:

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex status
```

Do not read or copy `~/.codex/auth.json`. The component keeps its own credential document under `$DSH_HOME`.
