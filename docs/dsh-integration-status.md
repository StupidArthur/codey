# DSH 集成现状与公开接口缺口

> **最终状态（2026-09-26）：V1 已验收关闭。** 产品执行与发现统一使用公开 ACP：`dsh --profile acp`、`session/new`、`session/resume`、`session/prompt`、`session/list(cwd)`。旧 transcript 仍无公开读取接口，V1 按约定显示 `Historical transcript unavailable`。下方 SDK resume 失败是已放弃执行路径的调查证据，不代表产品有待解决 gate。最终产品状态见 `docs/v1-acceptance.md` TODO 7。

## 历史集成调查（historical evidence; final implementation supersedes SDK path）

以下记录保留 SDK resume 缺口的调查证据及 ACP 选型原因。SDK 路径已不是产品执行路径，V1 已关闭。

日期：2026-09-25  
供 GitHub 审阅使用；结论针对仓库锁定的 `@deepseek-ai/dsh@0.1.7-rc.2`、`@deepseek-ai/dsh-sdk-client@0.1.7-rc.2` 与 `@agentclientprotocol/sdk@1.4.0`，不推断其他版本。

## 一句话结论

**新 Session 与持久 Session 的执行入口已统一接上公开 ACP：新 Session 用 `session/new`，已发现/已持久化的 Session 用公开 `session/resume`，跨进程上下文衔接已用真实模型验证通过；用真实凭证验证时，正式 SDK（`sdk` profile）无法 resume 已持久化 Session（服务端只 create、不 resume），因此 SDK resume 仍是真实的上游缺口，但已不再位于产品的执行路径上。** 旧历史读取仍是公开接口缺口，界面按 V1 决策显示只读占位。产品功能层面仍以 `docs/v1-acceptance.md` 的实际 gate 为准。

## 产品需要的能力与目前所见

| 能力 | 公开接口现状 | 仓库现状 |
| --- | --- | --- |
| 启动运行时、初始化、提交 Spec、接收事件、关闭 | SDK 支持；公开 ACP 亦支持 | `DshRuntime` 已统一走公开 ACP；真实凭证下初始化、首次/连续 prompt、事件、idle、跨进程 resume、关闭均通过 |
| 按 canonical Workspace 路径发现旧 Session | SDK wire 不提供；公开 ACP `session/list(cwd)` 支持筛选与 cursor 分页 | `SessionDiscovery.listByWorkspace` 已用 ACP SDK 实现；`WindowController.listSessions()` 已合并发现结果与产品记录；两个 Workspace + 空目录的隔离与分页已通过探针验证 |
| 读取旧 Session 对话供只读页面展示 | SDK wire 不提供；ACP 明确不支持 `session/load` 或旧更新回放 | `SessionDiscovery.readHistory()` 仍明确报不可用；界面改为只读占位 `Historical transcript unavailable`，不伪造 History |
| 已知 Session ID 继续原有上下文 | SDK wire 无 resume 方法；ACP 有可用的 `session/resume` | **SDK sdk-profile 无法 resume**：服务端对已知 ID 仍调用 `agents.create`，重启后报 `session "<id>" already exists`（见 `docs/dsh-upstream-resume-report.md`）。产品改用公开 ACP：`session/resume` 跨进程继承上下文已通过验证，且已成为 `DshRuntime` 的统一执行路径 |

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

需求要求先选目录，显示该目录全部 DSH Session；旧 Session 要有只读历史，并在第一次 Temporal 提交时沿用原 DSH 上下文。现在启动页已能展示“产品记录 + 公共 ACP 发现”的并集，不再只依赖本产品 SQLite。公开接口仍无法读取旧 transcript，界面按 V1 决策显示只读占位。**执行入口已统一到公开 ACP，旧 Session 的第一次提交与重启恢复沿用原上下文（`session/resume`）已具备可运行路径。**

## 可复核的代码与命令

- `src/main/dsh/SessionDiscovery.ts`：ACP `session/list` 发现适配器（分页、canonicalization、子进程生命周期、错误）。
- `src/main/dsh/sessionMerge.ts`：产品记录与发现结果的合并/去重与 legacy 状态。
- `src/main/WindowController.ts`：`listSessions()` 合并发现结果；首次打开旧 Session 时建立产品投影。
- `src/main/dsh/DshRuntime.ts`：统一公开 ACP 运行时（`session/new` / `session/resume` / `session/prompt`，事件投影，权限应答，子进程回收）。
- `src/main/dsh/projection.ts`：把 ACP 更新投影为 thinking/tool/verification/status/error，普通 assistant 文本不会标成 thinking。
- `src/main/evidence/EvidenceCollector.ts`：执行前后真实 workspace 证据（git/非 git/产物/工具事件）。
- `src/main/result/ResultBuilder.ts`：确定性的 Summary/Changes/Verification/Remaining，未采集到证据绝不写“已通过”。
- `src/main/loop/LoopController.ts`：固定预算与证据门槛的 Loop 状态机。
- `src/main/rounds/RoundEngine.ts`：Plan 版本复用、Vibe 累积、Loop 独立 Round 与终态。
- `scripts/probes/dsh-runtime-p0.mjs`：P0 运行时探针。无凭证时只验证初始化（退出码 2）；有凭证时输出各阶段结构化结果（失败退出码 1）。
- `scripts/probes/dsh-runtime-diag.mjs`：定位失败阶段的诊断探针（只输出事件种类与计数）。
- `scripts/probes/dsh-acp-exec.mjs`：ACP 新 Session、连续 prompt、跨进程 resume、文件写入与事件种类探针。
- `scripts/probes/dsh-runtime-impl.mjs`：直接驱动 `DshRuntime` 的新建 + 恢复探针。
- `scripts/probes/dsh-acp-resume.mjs`：ACP `session/resume` 跨进程上下文探针。
- `scripts/probes/dsh-acp-discovery.mjs`：真实 ACP `session/list` 隔离与分页探针。
- `scripts/probes/dsh-session-discovery-impl.mjs`：直接调用 `SessionDiscovery` 的端到端探针。
- `scripts/probes/dsh-session-merge.mjs`：合并/去重与 legacy 状态断言。
- `scripts/probes/temporal-domain.mjs`：产品域不变量（迁移、draft revision、Round 复用、证据 cross-check、Loop 预算、跨进程租约）自动化探针。
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
node scripts/probes/dsh-acp-exec.mjs
node scripts/probes/dsh-runtime-impl.mjs
ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/temporal-domain.mjs
```

本调查记录形成时，Windows `typecheck` / `build`、公开 ACP 握手和恢复、ACP discovery 隔离/分页、产品域不变量均通过。SDK 跨进程 resume 当时仍失败（上游缺口），因此转用 ACP。后续安装包内启动和旧 Session 实际验收已在 `docs/v1-acceptance.md` 完成并关闭。

## 希望审阅者帮助确认

1. 对 `0.1.7-rc.2`，是否存在**公开且稳定**的旧 Session transcript/消息读取或导出接口？若有，请指出包、方法和版本。只读历史不需要重新执行旧 turn。
2. 推荐如何在 SDK 执行进程旁使用 ACP `session/list(cwd)`，并保证它们看到同一持久 Session 集合？是否有更合适的公开 discovery 接口？
3. 已核实：`DeepSeekHarness.session(existingId).run()` **不会**从磁盘恢复旧上下文——`sdk` profile 的 JSON-RPC 服务端只 `create` 不 `resume`，已持久化 ID 会报 `already exists`。本产品已改为通过公开 ACP `session/resume` 执行旧 Session（见 `docs/architecture-review.md`）。请确认：SDK wire 是否有计划增加公开 resume，或是否有公开的 resume 开关；若暂无，我们继续以 ACP 作为受支持的公开路径。

历史注：上游问题仍作为调查材料保留；产品不等待这些问题的答复。V1 不解析 DSH 私有存储，也不展示伪造历史。
