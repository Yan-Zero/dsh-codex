# 迁移并修复历史 Codex 搜索 Session

[English](session-repair.md) | 中文

本文说明 dsh-codex 0.3.0 提供的一次性 `repair-session` 命令。应通过安装了插件的 profile 执行，通常为 `dsh plugin --profile web exec dsh-codex repair-session`。当旧版 dsh-codex 写入了不带可忽略标记的 `web/openai-codex-search-llm-request`，导致 DSH 拒绝历史 Session 时使用。

## 何时需要修复

dsh-codex 0.3.0 之前的版本会把每次解析后的 Codex 独立搜索请求记录为插件自有 Session 事件。该事件只用于诊断：普通对话重放依赖现有的 `tool/call` 与 `tool/result`，不依赖这份 provider wire 请求。但旧事件信封没有携带 `ignorable: true`。

DSH 的历史 Session 迁移使用构建时冻结的事件清单。冷读取受影响的 v0、v1 或 v2 generation 时，可能因此失败，并在错误中指出：

```text
web/openai-codex-search-llm-request
```

源 Session 仍然完整；DSH 会在发布迁移结果之前拒绝处理。

如果错误指向其他事件、Session 已经存在有效的当前 generation，或者所选 generation 不含旧 Codex 搜索事件，则不需要此修复。

## 安全保证

命令默认执行 dry-run，并递归扫描 `$DSH_HOME/sessions`；也可以显式传入一个目录树或一个准确的 generation 文件。目录模式会按 Session 目录归组规范 generation，跳过已经存在当前 generation 的 Session，并且只检查其余各 Session 中版本最新的历史 generation。

- 源文件必须采用规范的 `session[.vN].jsonl` 或 `session[.vN].jsonl.zstd` 文件名，是单链接普通文件，并且在 POSIX 上仅属主可访问。
- 递归发现不会跟随符号链接目录。若最新版本同时存在两种编码，命令会报告歧义，不会自行猜测。
- 支持 v0、v1 与 v2 源文件；0.3.0 命令以 DSH 0.1.5 当前的 v3 格式为目标。
- 绝不修改或删除源文件路径、字节或文件身份。
- 目标为同目录的 `session.v3.jsonl` 或 `session.v3.jsonl.zstd`，并保持源文件编码。
- 发布先完整写入并同步同目录临时文件，再通过硬链接独占创建目标；绝不覆盖已有目标。
- 如果源文件在检查或暂存期间发生变化，命令会在发布前失败。
- 发布前会同时校验当前逻辑产物与暂存的物理 JSONL／Zstandard 文件。

执行实际修复前，请停止使用同一 Session root 的所有 dsh 进程。命令可以检测多种竞争，但不能代替停止写入者。批量执行时，无效 Session 会分别报告，不会阻止其他有效 Session 完成修复；只要存在失败项，命令就以非零状态退出。

## 1. 预览全部 Session

使用安装了 dsh-codex 的 profile。不传路径时，命令会发现标准 DSH home 下的全部 Session：

```sh
dsh plugin --profile web exec dsh-codex repair-session
```

这会调用所选 profile 中安装的插件包，而不会启动 Web 应用。`$DSH_HOME` 仍按 DSH 的标准规则解析，缺省时使用 `~/.dsh`。

预检成功时会报告汇总数量，并为每个受影响 Session 列出计划创建的 v3 目标；不会写入文件。当前格式与不受影响的 Session 只会计数，不会重写。

需要机器可读输出时使用：

```sh
dsh plugin --profile web exec dsh-codex repair-session --json
```

## 2. 必要时缩小扫描范围

传入目录即可只递归扫描该目录树：

```sh
dsh plugin --profile web exec dsh-codex repair-session "/srv/dsh/sessions/project"
```

需要定向诊断时，也可以传入 Harness 错误中附带的完整 raw-log 路径：

```sh
dsh plugin --profile web exec dsh-codex repair-session "/srv/dsh/sessions/project/id/session.jsonl.zstd"
```

规范示例：

```text
/home/user/.dsh/.../session.jsonl.zstd
C:\Users\user\.dsh\...\session.jsonl.zstd
/srv/dsh/.../session.v1.jsonl
```

不要选择 `session.v3.jsonl[.zstd]`；它是修复命令将生成的当前目标。目录扫描会自动跳过它。

Windows PowerShell 可以使用同一条 profile 内命令和原生路径：

```powershell
dsh plugin --profile web exec dsh-codex repair-session "C:\Users\user\.dsh\sessions"
```

## 3. 应用修复

检查预览结果，并确认使用该 Session root 的所有 dsh 进程均已停止后，对同一范围增加 `--apply`。正常迁移整个 home 时使用：

```sh
dsh plugin --profile web exec dsh-codex repair-session --apply
```

命令会发布每个计划中的 v3 同目录文件，并打印对应的源路径与目标路径。它会继续处理彼此独立的 Session；如有任何失败项，则以非零状态退出，方便继续排查。随后重新启动 dsh，正常打开 Session。DSH 会选择版本最高的规范 generation；所有旧源文件仍作为不可变的恢复证据保留。

## 命令具体修改什么

命令首先严格校验每个旧事件的 Codex 请求结构：固定 endpoint、请求身份、模型、输入文本、搜索命令、搜索策略和输出上限。未知或缺失字段会被拒绝，不会猜测。

之后依次执行：

1. 用唯一且保持事件数量不变的内部标记临时替换每个旧事件；
2. 把完整历史 Session 交给 DSH 0.1.5 官方相邻格式目录处理；
3. 由官方迁移折叠 stream 并重映射 Session 序号引用；
4. 在迁移后的标记位置恢复原始 Codex event data，并添加 `ignorable: true`；
5. 校验并编码完整 v3 产物；
6. 通过官方当前格式校验器重新读取暂存的物理文件；
7. 再次检查源文件身份，然后独占发布目标。

临时标记绝不会进入持久文件。命令不会把事件伪装成 DeepSeek 搜索请求，也不会创建私有 sidecar 日志。

## 失败信息

| 信息片段 | 含义 |
|---|---|
| `expected a canonical session[.vN]...` | 参数不是准确的规范 generation 文件名。 |
| `filename and Session header versions disagree` | 文件名与内部物理格式版本不一致。 |
| `source ... is not older than repair target` | 选择了 v3 文件；本命令只修复历史 v0-v2 generation。 |
| `contains no retired Codex search events` | 该 Session 不需要这项定向修复。 |
| `multiple vN generations` | 最新历史版本同时存在原始与 Zstandard 文件；调查后显式传入希望处理的文件。 |
| `unexpected field`、`lacks` 或 `is invalid` | 旧 payload 不是已知的准确 dsh-codex 请求格式，因此保持不动。 |
| `a current Session generation already exists` | Session 已经以任一支持编码存在 v3 generation；命令不会覆盖。 |
| `source generation changed` | 其他进程修改了源文件。请停止 dsh 后重新预检。 |
| `source must be owner-only` | 在 POSIX 上确认属主后，对源文件执行 `chmod 600`。 |

发生错误不会修改源文件；暂存文件会尽力清理。

## 回退与保留

修复成功后不要删除历史源文件。如果修复后的 Session 表现异常，请停止 dsh，把新生成的 `session.v3.jsonl[.zstd]` 移出 Session 目录以便调查；移回该文件即可恢复修复后的 generation。缺少它时，原历史 generation 仍需完成修复，当前 DSH 才能打开。

不要把历史源文件改名为 v3 目标，也不要原地编辑压缩字节。

## 限制

- 命令只修复 `web/openai-codex-search-llm-request`，不会绕过文件损坏或其他未知 required event。
- 不重写 v3 文件。
- 执行期间会物化所选压缩字节、解码后的 JSONL 与最终逻辑产物；超大 Session 需要相应的可用内存。
- 配合 DSH 0.1.7-rc.2 时，修复命令仍有意发布 v3。需要收集子 Session 事实、理解父子关系的 v3→v4 迁移属于 Harness 持久化层；这个独立修复命令不会伪造这些事实。
- dsh-codex 0.3.0 不再写入新的旧事件；该命令只是为早期版本提供的临时兼容工具。
