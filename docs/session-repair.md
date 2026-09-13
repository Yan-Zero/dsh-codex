# Migrate and repair historical Codex search Sessions

English | [中文](session-repair.zh.md)

This guide covers the one-time `repair-session` command shipped by dsh-codex 0.3.0. Run it through the profile that contains the plugin, normally `dsh plugin --profile web exec dsh-codex repair-session`. Use it when DSH refuses historical Sessions because an earlier dsh-codex release wrote `web/openai-codex-search-llm-request` without an ignorable event marker.

## When repair is required

dsh-codex versions before 0.3.0 recorded each resolved Codex standalone-search request as a plugin-owned Session event. The event is diagnostic: normal conversation replay uses the existing `tool/call` and `tool/result`, not this provider wire request. However, the older event envelope did not carry `ignorable: true`.

DSH's historical Session migrations use an event inventory frozen at build time. A cold read of an affected v0, v1, or v2 generation can therefore fail with an error naming:

```text
web/openai-codex-search-llm-request
```

The source Session is intact. The refusal occurs before DSH publishes a migrated generation.

Repair is unnecessary when the error names another event, the Session already has a valid current generation, or the selected generation contains no retired Codex search event.

## Safety guarantees

The command defaults to a dry run and recursively scans `$DSH_HOME/sessions`. You may instead pass a directory tree or one exact generation file. Directory mode groups canonical generations by Session directory, skips Sessions that already have a current generation, and inspects only the newest historical generation in each remaining Session.

- The source must be a canonical `session[.vN].jsonl` or `session[.vN].jsonl.zstd` file, a single-link regular file, and owner-only on POSIX.
- Recursive discovery never follows symlinked directories. If both encodings exist for the newest version, the Session is reported as ambiguous instead of guessed.
- v0, v1, and v2 sources are supported. The 0.3.0 command targets DSH 0.1.5's current v3 format.
- The source path, bytes, and file identity are never changed or deleted.
- The target is a sibling `session.v3.jsonl` or `session.v3.jsonl.zstd`, preserving the source encoding.
- Publication uses a fully written and synced same-directory temporary file followed by exclusive hard-link creation. An existing target is never overwritten.
- A source that changes while inspection or staging is in progress causes the command to fail before publication.
- Both the logical current artifact and the staged physical JSONL/Zstandard file are validated before publication.

Stop every dsh process using the same Session root before applying a repair. The command detects several races, but it is not a replacement for quiescing the writer. In a batch, invalid Sessions are reported independently and do not prevent valid Sessions from being repaired; any reported failure makes the command exit nonzero.

## 1. Preview all Sessions

Use the profile in which dsh-codex is installed. With no path argument, the command discovers every Session below the standard DSH home:

```sh
dsh plugin --profile web exec dsh-codex repair-session
```

This invokes the plugin package installed in the selected profile without booting the Web application. `$DSH_HOME` is resolved by DSH normally, falling back to `~/.dsh`.

A successful preview reports aggregate counts and one proposed v3 target per affected Session. It writes nothing. Current and unaffected Sessions are counted but not rewritten.

For machine-readable output:

```sh
dsh plugin --profile web exec dsh-codex repair-session --json
```

## 2. Narrow the scan when needed

Pass a directory to recursively scan only that tree:

```sh
dsh plugin --profile web exec dsh-codex repair-session "/srv/dsh/sessions/project"
```

For targeted diagnosis, pass the complete raw-log path included in the Harness error:

```sh
dsh plugin --profile web exec dsh-codex repair-session "/srv/dsh/sessions/project/id/session.jsonl.zstd"
```

Canonical examples:

```text
/home/user/.dsh/.../session.jsonl.zstd
C:\Users\user\.dsh\...\session.jsonl.zstd
/srv/dsh/.../session.v1.jsonl
```

Do not select `session.v3.jsonl[.zstd]`; that is the current target produced by the repair. A directory scan skips it automatically.

Windows PowerShell accepts the same profile-local command and native path:

```powershell
dsh plugin --profile web exec dsh-codex repair-session "C:\Users\user\.dsh\sessions"
```

## 3. Apply the repair

After reviewing the preview and confirming that every dsh process using this Session root is stopped, repeat the same scope with `--apply`. For the normal full-home migration:

```sh
dsh plugin --profile web exec dsh-codex repair-session --apply
```

The command publishes each proposed v3 sibling and prints its source and target. It continues across independent Session failures and exits nonzero if any need attention. Restart dsh and open the Sessions normally. DSH selects the highest canonical generation; every older source remains available as immutable recovery evidence.

## What the command changes

For each retired event, the command first validates the exact Codex request structure: fixed endpoint, request identity, model, input text, search command, search policy, and output limit. Unknown or missing fields are rejected instead of guessed.

The command then:

1. substitutes a unique, cardinality-preserving internal marker for each retired event;
2. sends the complete historical Session through DSH 0.1.5's official adjacent format catalog;
3. lets the official migrations fold streams and remap Session sequence references;
4. restores the original Codex event data at the migrated marker position with `ignorable: true`;
5. validates and encodes the complete v3 artifact;
6. reads the staged physical file back through the official current-format validator; and
7. exclusively publishes the target after rechecking the source identity.

The temporary marker is never persisted. No event is relabelled as a DeepSeek search request, and no private sidecar log is created.

## Failure messages

| Message fragment | Meaning |
|---|---|
| `expected a canonical session[.vN]...` | The argument is not an exact canonical generation filename. |
| `filename and Session header versions disagree` | The filename and embedded physical format version do not match. |
| `source ... is not older than current` | A v3 file was selected; this command repairs historical v0-v2 generations only. |
| `contains no retired Codex search events` | This Session does not need this targeted repair. |
| `multiple vN generations` | Both raw and Zstandard files exist for the newest historical version; pass the intended file explicitly after investigating. |
| `unexpected field`, `lacks`, or `is invalid` | The retired payload is not one of the exact known dsh-codex request forms and was left untouched. |
| `a current Session generation already exists` | The Session already has a v3 generation in either supported encoding; the command will not overwrite it. |
| `source generation changed` | Another process changed the source. Stop dsh and preview again. |
| `source must be owner-only` | On POSIX, run `chmod 600` on the source after verifying its ownership. |

An error does not modify the source. A temporary staging file is removed best-effort.

## Rollback and preservation

Do not delete the historical source after a successful repair. If the repaired Session does not behave as expected, stop dsh and move the generated `session.v3.jsonl[.zstd]` out of the Session directory for investigation. Moving it back restores the repaired generation. Without it, the original historical generation will again require repair before current DSH can open it.

Never rename the historical source to the v3 target and never edit compressed bytes in place.

## Limitations

- The command repairs only `web/openai-codex-search-llm-request`; it does not bypass corruption or other unknown required events.
- It does not rewrite already-current v3 files.
- It materializes the selected compressed bytes, decoded JSONL, and final logical artifact during the operation. Very large Sessions require corresponding free memory.
- It uses the DSH 0.1.5-rc.2 format catalog bundled as the 0.3.0 dependency baseline. Do not use this release to manufacture a target for a different current Session format.
- dsh-codex 0.3.0 no longer writes new copies of the retired event. The command is temporary compatibility tooling for earlier releases.
