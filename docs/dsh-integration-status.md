# DSH 集成现状与公开接口缺口

日期：2026-09-25  
供 GitHub 审阅使用；结论针对仓库锁定的 `@deepseek-ai/dsh@0.1.7-rc.2`、`@deepseek-ai/dsh-sdk-client@0.1.7-rc.2` 与 `@agentclientprotocol/sdk@1.4.0`，不推断其他版本。

## 一句话结论

**新 Session 的执行入口已接上 SDK：“按 Workspace 发现已有 DSH Session → 在原 Session 上继续”的发现环节已通过公开 ACP `session/list(cwd)` 打通并验证；但用真实凭证验证时，正式 SDK 运行时无法 resume 已持久化的 Session（`sdk` profile 服务端只 create、不 resume），因此“旧 Session 上下文衔接”与“重启恢复”仍不成立。** 旧历史读取仍是公开接口缺口。当前代码不能被视为 V1 功能完成。

## 产品需要的能力与目前所见

| 能力 | 公开接口现状 | 仓库现状 |
| --- | --- | --- |
| 启动运行时、初始化、提交 Spec、接收事件、关闭 | SDK 支持 | `DshRuntime` 已接入；真实凭证下初始化、首次/连续 prompt、事件、idle、关闭均通过（resume 失败见下行） |
| 按 canonical Workspace 路径发现旧 Session | SDK wire 不提供；公开 ACP `session/list(cwd)` 支持筛选与 cursor 分页 | `SessionDiscovery.listByWorkspace` 已用 ACP SDK 实现；`WindowController.listSessions()` 已合并发现结果与产品记录；两个 Workspace + 空目录的隔离与分页已通过探针验证 |
| 读取旧 Session 对话供只读页面展示 | SDK wire 不提供；ACP 明确不支持 `session/load` 或旧更新回放 | `SessionDiscovery.readHistory()` 仍明确报不可用；界面改为只读占位 `Historical transcript unavailable`，不伪造 History |
| 已知 Session ID 继续原有上下文 | SDK wire 无 resume 方法；ACP 有可用的 `session/resume` | **SDK sdk-profile 无法 resume**：服务端对已知 ID 仍调用 `agents.create`，重启后报 `session "<id>" already exists`。真实凭证下已复现：同进程连续 prompt 继承上下文，但**跨进程 resume 失败**；公开 ACP `session/resume` 跨进程继承上下文已通过验证（待架构决策是否改走 ACP 执行） |

依据：[SDK 协议方法表](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)只列出 `initialize`、`session/prompt`、`shutdown` 三个请求；[SDK 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)描述了运行和指定 Session ID 的 API；[ACP 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)列出 `session/list(cwd)`、`session/resume`，并明确说明旧 transcript 不回放、`session/load` 不支持；仓库安装的同版本 ACP README 也包含相同限制。

### 阶段 1 验证到的 ACP 行为（`0.1.7-rc.2`）

- `dsh --profile acp` 通过 stdio 提供标准 ACP v1；`initialize` 返回 `protocolVersion: 1` 且声明 `sessionCapabilities.list`。
- `session/list(cwd)` 只返回该 canonical workspace 的持久化 root session，按最新优先排序。
- 通过 `--patch` 把 `sessionListPageSize` 设为 2 时，返回 `nextCursor` 并可翻页，验证 cursor 分页。
- `session/new` 创建的 Session 在持久化（例如 `session/close`）之前不会出现在 `session/list`。
- SDK 与 ACP profile 共用同一个单根 DSH home（`$DSH_HOME` → `~/.dsh`）。

### 阶段 2 验证结论（真实凭证，`0.1.7-rc.2`）

`DEEPSEEK_API_KEY` 下运行 `dsh-runtime-p0.mjs`：

| 阶段 | 结果 |
| --- | --- |
| `initialize` | 通过 |
| `first-prompt`（首次 prompt、assistant 事件、idle） | 通过 |
| `sequential-prompt`（同进程连续 prompt、继承上下文） | 通过 |
| `resume-after-restart`（关闭运行时后新进程 resume） | **失败**：`session "<id>" already exists` |
| 子进程关闭 | 通过 |

根因（公开代码可复核）：`@deepseek-ai/dsh-sdk-jsonrpc-server` 的 `prompt` 只调用 `ctx.agents.create({ sessionId, meta })`，从不调用 `ctx.agents.resume(...)`。当 Session 已持久化时，`agents.create` 在同一 store 上抛 `session "<id>" already exists`。SDK wire 也只有 `initialize`/`session/prompt`/`shutdown`，没有 resume 方法。

对照验证 `scripts/probes/dsh-acp-resume.mjs`：`session/new` + `session/prompt` 记住标记 → 关闭 → 新进程 `session/resume` + `session/prompt`，能正确取回标记（`hasToken: true`）。即**公开 ACP 可以跨进程续接上下文，SDK sdk-profile 不能**。

## 对当前需求的影响

需求要求先选目录，显示该目录全部 DSH Session；旧 Session 要有只读历史，并在第一次 Temporal 提交时沿用原 DSH 上下文。现在启动页已能展示“产品记录 + 公共 ACP 发现”的并集，不再只依赖本产品 SQLite。但公开接口仍无法读取旧 transcript，界面按 V1 决策显示只读占位。**阻止验收的是：正式 SDK 执行路径无法 resume 已持久化 Session，导致“第一次提交沿用原上下文”和“重启恢复”不成立；公开 ACP `session/resume` 是可用的替代路径，但属于架构决策。**

## 可复核的代码与命令

- `src/main/dsh/SessionDiscovery.ts`：ACP `session/list` 发现适配器（分页、canonicalization、子进程生命周期、错误）。
- `src/main/dsh/sessionMerge.ts`：产品记录与发现结果的合并/去重与 legacy 状态。
- `src/main/WindowController.ts`：`listSessions()` 合并发现结果；首次打开旧 Session 时建立产品投影。
- `src/main/dsh/DshRuntime.ts`：SDK 运行时封装。
- `scripts/probes/dsh-runtime-p0.mjs`：P0 运行时探针。无凭证时只验证初始化（退出码 2）；有凭证时输出各阶段结构化结果（失败退出码 1）。
- `scripts/probes/dsh-runtime-diag.mjs`：定位失败阶段的诊断探针（只输出事件种类与计数）。
- `scripts/probes/dsh-acp-resume.mjs`：ACP `session/resume` 跨进程上下文探针。
- `scripts/probes/dsh-acp-discovery.mjs`：真实 ACP `session/list` 隔离与分页探针。
- `scripts/probes/dsh-session-discovery-impl.mjs`：直接调用 `SessionDiscovery` 的端到端探针。
- `scripts/probes/dsh-session-merge.mjs`：合并/去重与 legacy 状态断言。
- 探针只输出状态、计数、ID、事件种类与脱敏断言，不打印凭证或对话正文。

```text
pnpm.cmd install
pnpm.cmd typecheck
pnpm.cmd build
node scripts/probes/dsh-acp-discovery.mjs
node scripts/probes/dsh-session-discovery-impl.mjs
node scripts/probes/dsh-session-merge.mjs
node scripts/probes/dsh-runtime-p0.mjs
node scripts/probes/dsh-acp-resume.mjs
```

已在当前 Windows 环境通过 `typecheck`、`build`；DSH 初始化握手、首次/连续 prompt、事件、idle 与关闭通过；ACP discovery 隔离/分页/错误路径与 ACP resume 通过。**SDK 跨进程 resume 失败**；安装包内启动及旧 History **尚未验收**。

## 希望审阅者帮助确认

1. 对 `0.1.7-rc.2`，是否存在**公开且稳定**的旧 Session transcript/消息读取或导出接口？若有，请指出包、方法和版本。只读历史不需要重新执行旧 turn。
2. 推荐如何在 SDK 执行进程旁使用 ACP `session/list(cwd)`，并保证它们看到同一持久 Session 集合？是否有更合适的公开 discovery 接口？
3. 已核实：`DeepSeekHarness.session(existingId).run()` **不会**从磁盘恢复旧上下文——`sdk` profile 的 JSON-RPC 服务端只 `create` 不 `resume`，已持久化 ID 会报 `already exists`。请确认是否有公开的 SDK resume 开关或补丁；若无，是否应改为通过公开 ACP `session/resume` 执行旧 Session，或等待上游在 SDK wire 增加 resume？

在这些问题得到可运行验证前，仓库会继续保留显式缺口，不解析 DSH 私有存储，也不展示伪造历史。
