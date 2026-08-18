# Installation

`dsh-codex` is a Community v0.15 standard component. Its `@dsh-std/*` protocol packages are regular npm dependencies and are installed automatically with the component. Do not install those packages one by one.

The DSH adapter belongs to the target profile rather than to `dsh-codex`. Install it once in a Web profile, then install the component:

```sh
dsh plugin --profile web add @dsh-std/adapter-dsh
dsh plugin --profile web add dsh-codex
```

The package manager reuses compatible `@dsh-std/*` versions already present in the profile. Installing another standard component does not require another adapter.

After installation, restart the profile if it is already running. In DSH Web and browser-rendered Desktop shells, open **Settings → OpenAI Codex** to sign in and configure the provider. The settings section is supplied through the negotiated browser UI surface; `/codex` is intentionally not registered in the Web command palette.

## TUI and other standard Hosts

A profile that already provides the DSH Standard adapter only needs the component:

```sh
dsh plugin --profile tui add dsh-codex
```

In dsh-tui, the component declares the TUI `CommandLine` placement, so account operations are available as commands:

```text
/codex status
/codex login
/codex login browser
/codex usage
/codex config
/codex logout
```

`/codex login` selects browser authentication when the active presentation provides `ExternalRedirect`, and otherwise uses device-code authentication. `/codex login browser` explicitly requests the exact `http://localhost:1455/auth/callback` URI; `/codex login device` always selects the device-code flow.

Other Hosts can load the component when they support Community v0.15 component discovery and negotiate the protocols declared in `dsh-plugin.json`. Product-specific UI surfaces are optional; model, tool, session, command, and presentation behavior remains behind the corresponding standard protocols.

## Standalone credential command

The package executable can manage the profile-local Codex credentials without a UI command surface:

```sh
dsh plugin --profile web exec dsh-openai-codex login
dsh plugin --profile web exec dsh-openai-codex status
```

The component stores its credential document under `$DSH_HOME`. It does not read or copy `~/.codex/auth.json`.

## Source checkout

For development, build the checkout and install its absolute path into a test profile:

```sh
pnpm install
pnpm build
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

The target profile still needs a compatible adapter. Linking the component source does not replace the profile's Host implementation.
