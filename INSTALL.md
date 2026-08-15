# Installation Runbook for CLI Agents

This is the complete installation procedure for Codex, Claude Code, and other automation agents. Do not inspect plugin source or another plugin to infer missing steps.

## Objective

Install the public `dsh-codex` bundle into the requested DeepSeek Harness profile, enable its model and search routes, preserve unrelated user configuration, and verify non-secret login state.

## Defaults

- **Package:** install `dsh-codex` from the configured npm registry. Use a local checkout only when the user explicitly supplies one for development.
- **Profile:** use the user-named profile; otherwise use `web`.
- **Launcher:** prefer an installed `dsh`. From a DeepSeek Harness source checkout, run commands in that checkout and replace `dsh` with `pnpm dsh`.
- **Search mode:** use `live` unless the user requests `cached` or `indexed`.

The bundle uses standard dsh plugin APIs. Do not patch, fork, build, or commit changes to the dsh repository during installation.

## Safety requirements

- Never read, print, copy, move, or modify `~/.codex/auth.json`.
- Never print `$DSH_HOME/.openai-codex-auth.json` or include it in diagnostics.
- Never add credentials, OAuth URLs or codes, tokens, account identifiers, or generated profile state to Git.
- Preserve every unrelated profile dependency, bundle, and `cordis.patch.yml` row.
- OAuth approval belongs to the user. Never request an OpenAI password or attempt to complete the account page for them.

## Procedure

### 1. Validate the launcher

Run `dsh --version` or `dsh --help`. From a source checkout, run `pnpm dsh --version` or `pnpm dsh --help`. Stop and report the exact launcher failure if it does not run.

### 2. Install the bundle

For the default Web profile:

```sh
dsh plugin --profile web add dsh-codex
```

From a Harness source checkout:

```sh
pnpm dsh plugin --profile web add dsh-codex
```

If the user explicitly supplied a local checkout, first require `package.json`, `cordis.patch.yml`, `lib/index.js`, `lib/client.js`, and `lib/bin.js`, and require `package.json.name` to equal `dsh-codex`. Then install its normalized absolute path, using forward slashes on Windows:

```sh
dsh plugin --profile web add link:E:/absolute/path/to/dsh-codex
```

Do not run a build when committed `lib/` artifacts are present. The install command is idempotent and must leave `dsh-codex` in the profile dependency map and `dsh.profile.bundles` exactly once.

### 3. Configure search without replacing user settings

Resolve the profile directory as `$DSH_HOME/profiles/<profile>`; when `DSH_HOME` is unset, use `~/.dsh/profiles/<profile>`.

Edit its `cordis.patch.yml`, preserving all unrelated rows. Ensure exactly one row with id `llm-openai-codex` contains the selected search mode:

```yaml
- id: llm-openai-codex
  config:
    searchMode: live
```

If the file contains only `[]`, replace that token with the row. If the id exists, update `config.searchMode` and retain its other fields. Never append a duplicate id.

### 4. Validate the effective composition

Run:

```sh
dsh --profile web --dump-config
```

Require all of these facts:

- `llm-openai-codex` loads `dsh-codex`;
- `agent-default-model` selects provider `openai-codex` and model `gpt-5.6-sol`, unless a later user setting overrides it;
- the `web` row selects `searchProvider: openai-codex`;
- `llm-openai-codex.config.searchMode` equals the selected mode.

Stop and report the exact diagnostic if composition fails. Do not start OAuth while the bundle is absent or malformed.

### 5. Reuse or create the dsh login

Check non-secret status:

```sh
dsh plugin --profile web exec dsh-openai-codex status
```

If it reports `signed in`, do not start another login. If signed out and an interactive terminal is available, run:

```sh
dsh plugin --profile web exec dsh-openai-codex login
```

The command opens OpenAI's page and waits for its localhost callback. Tell the user to approve the page and keep waiting for completion. Never ask the user to paste a token. If the host cannot open a browser, use:

```sh
dsh plugin --profile web exec dsh-openai-codex login --device-code
```

For a local Web profile, the equivalent path is **Settings → OpenAI Codex → Sign in with ChatGPT**. Do not require both GUI and CLI login. After approval, rerun `status` and require `signed in`.

### 6. Verify Web integration

For the `web` profile, start `dsh web` if the user wants the application running. Require:

- the root page loads;
- its boot manifest contains `dsh-codex` and the plugin `client.js` URL;
- `GET /plugins/dsh-openai-codex/auth/status` returns JSON without credentials;
- Settings contains an **OpenAI Codex** section.

Do not call the login endpoint as a health check because it starts OAuth. The Web composer already owns image paste and drop; do not patch dsh for Ctrl+V. The bundle can extend Harness's `read_image` with HTTP(S) URL input and adds `imagegen`; the current model route must explicitly advertise image input before either tool returns an image. `imagegen.output_path` is optional: without it, the plugin writes a uniquely named PNG in the active workspace. The generated attachment remains available when policy or filesystem capability refuses that write.

### 7. Report completion

Report only:

- installed profile;
- installed `dsh-codex` version or local checkout path;
- selected search mode;
- signed-in or signed-out state;
- whether the Web client entry was detected.

Do not report OAuth URLs, authorization codes, token timestamps, account ids, or auth-file contents.

## Failure handling

- **Package not found:** confirm the registry is `https://registry.npmjs.org/` and retry the exact package name `dsh-codex`.
- **Executable not found:** run `dsh plugin --profile <profile> why dsh-codex`, then repeat the add command.
- **Client entry missing:** confirm the installed package contains `lib/client.js`, restart dsh, and repeat composition validation.
- **Duplicate provider:** remove only a manually configured `llm-pi-ai.providers.openai-codex` route.
- **401/403 after login:** run the dedicated login again; do not copy Codex CLI credentials.
- **OAuth callback cannot bind:** retry with `--device-code`.
- **Browser account route returns 403:** browser login is loopback-only; use CLI login on the dsh host.
- **Profile patch parse failure:** repair only the `llm-openai-codex` row, preserve unrelated rows, and rerun `--dump-config`.
- **Image refusal:** select a Codex model whose catalog explicitly declares image input.
- **Unknown `web/search-model-request`:** this event came from the discontinued fork implementation. Ask before deleting or migrating the named session; never alter all sessions automatically.

## Updating

```sh
dsh plugin --profile web update dsh-codex
```

Restart dsh and repeat composition, login-status, and Web verification. A local `link:` installation follows its checkout and is reconciled by repeating the local add command instead.

## Removal

Only when explicitly requested:

```sh
dsh plugin --profile web remove dsh-codex
```

Remove only the `llm-openai-codex` row from the profile patch. Credential deletion is separate and requires explicit authorization:

```sh
dsh plugin --profile web exec dsh-openai-codex logout
```
