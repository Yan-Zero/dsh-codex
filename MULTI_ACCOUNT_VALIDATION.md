# DSH Codex 多账号交付验证（2026-09-06）

实际加载仓库：`13_dsh_auto_update/staging/dsh-codex-20260905`，Web profile 的 dsh-codex 链接指向此目录。

实现：命名账号、新增与独立登录、重命名、当前账号选择、默认关闭的额度耗尽自动切换；配额缓存按账号隔离。模型请求固定账号，自动重试仅明确额度错误且无已输出内容，尊重请求期间的手动选择/关闭开关。搜索与图像请求跟随选择并在请求内固定凭证。旧默认账号保留，私有 replay 与 native checkpoint 防止跨账号混用。使用步骤与 native checkpoint 限制见 README.zh.md / README.md。

验证：

- 最终 `pnpm run check` 成功，37 个测试文件、286 项测试通过，类型检查与主机/客户端构建成功。
- 早期集成发现 Models/MutableModels 类型问题，已修复；最终检查也发现旧默认账号无归属 replay 被清理的兼容问题，已修复并新增回归。
- 原 `@linxin666/dsh-usage@0.3.16` 桥接源码及编译包各 8 项回归通过；多账号查询固定 accountId，失败时不会沿用其他账号旧配额。补丁维护在相邻 `dsh-usage-codex-fix` 目录。
- 本机 dsh-web 已温和重启，维持原工作目录。
- 实际 GET accounts：selectedAccountId=default，autoSwitch=false，默认账号 authenticated=true。
- 实际 GET auth/local-status?accountId=default：authenticated=true。
- 实际使用统计接口：Codex credential=oauth，每周已用17%，无查询错误。
- 跨站 GET accounts 实际返回403。
- Browser 连接发现返回空列表，未进行浏览器视觉检查；界面使用组件交互测试验证。
- 多账号登录/请求隔离、自动切换、取消、私有历史与配额隔离使用临时 fake credentials 和 mock 网络验证。没有新增真实账号或发起第二个真实账号的授权/模型调用；新增账号须由用户完成 OAuth 登录。

没有发布远程包或提交 Git；当前源码及构建产物已供本机 Web 使用。
