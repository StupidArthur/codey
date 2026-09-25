# P0 Acceptance — DSH 旧 Session 闭环

日期：2026-09-25  
范围：`todo_1.md` 阶段 1–4。状态仅取 **通过 / 未通过 / 未运行**。  
证据原则：只记录命令、计数、ID 与脱敏断言；不含凭证或对话正文。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | ACP 发现旧 Session（`session/list(cwd)`） | **通过** |
| 2 | 真实模型 P0 与恢复 | **未通过**（SDK resume 失败；ACP resume 可用） |
| 3 | 正式 Runtime 改用 `HarnessClient` | **未运行** |
| 4 | Windows 安装包验证 | **未运行** |

---

## 阶段 1 — ACP 发现旧 Session：通过

### 实现

- `src/main/dsh/SessionDiscovery.ts`：用公开 `@agentclientprotocol/sdk`（v1.4.0）驱动 `dsh --profile acp`；`initialize` → `session/list(cwd)` cursor 分页 → 关闭子进程。只使用公开 ACP 方法与 `@deepseek-ai/dsh` 公开包清单解析 bin，不读私有 JSONL、不手写 DSH 协议。工作目录先经 `fs.realpath` canonicalization。
- `src/main/dsh/sessionMerge.ts`：产品记录与发现结果合并；同一 DSH ID 只出现一次；未投影的旧 Session 标记为 `kind: 'legacy'`；`historyStateFor` 给出 `legacy-unavailable` 状态。
- `src/main/WindowController.ts`：`listSessions()` 返回 `SessionListResult`（合并结果 + 真实 `discoveryError`）；首次打开旧 Session 时通过公共 ACP 校验成员关系后建立产品投影，随后使用原 DSH ID。
- `src/shared/contracts.ts`：`SessionSummary` 增加 `dshSessionId?` 与 `kind: 'new' | 'temporal' | 'legacy'`；`WorkspaceSnapshot` 用显式 `historyState` 取代 `importedHistoryMarkdown`，不再伪造 History。
- `src/renderer/src/main.tsx`：移除伪造 History 入口；旧 Session 显示 `Existing DSH Session` + `Historical transcript unavailable` 只读占位；列表显示 `kind` 文案与发现错误。

### 复现命令

```text
pnpm.cmd typecheck
pnpm.cmd build
node scripts/probes/dsh-acp-discovery.mjs
$env:P0_ACP_PAGE_SIZE='2'; node scripts/probes/dsh-acp-discovery.mjs
node scripts/probes/dsh-session-discovery-impl.mjs
node scripts/probes/dsh-session-merge.mjs
$env:ELECTRON_RUN_AS_NODE='1'; & (node -e "console.log(require('electron'))") scripts/probes/dsh-discovery-persistence.mjs
```

### 脱敏证据

`node scripts/probes/dsh-session-discovery-impl.mjs`（真实实现，非内联复刻）：

| 断言 | 结果 |
| --- | --- |
| `resolveInstalledDshBin()` 与探针解析的 bin 一致 | `true` |
| Workspace A 仅返回 A 的 3 个 Session | `count=3, unique=3, isolation=true` |
| Workspace B 仅返回 B 的 2 个 Session | `count=2, unique=2` |
| 空目录返回 0 | `listEmpty=0` |
| 重复发现稳定、全部已播种 Session 可见 | `repeatStable=true, allSeededVisible=true` |
| 不可用 bin 时抛真实错误 | `threw=true, name=DshDiscoveryError` |

`$env:P0_ACP_PAGE_SIZE='2'; node scripts/probes/dsh-acp-discovery.mjs`（真实 ACP）：

- `initialize.protocolVersion=1`；`agentCapabilities.sessionCapabilities={close,list,resume}`。
- A：两页（`2 + 1`），每页仅含 A 的 `cwd`，第一页 `nextCursor` 存在。
- B：`count=2`；空目录：`count=0`。
- 子进程正常退出（`exitCode=0`，无 stderr）。

`node scripts/probes/dsh-session-merge.mjs`：10 项断言全部 `true`（无重复 ID、已投影的 DSH ID 由产品记录胜出且只出现一次、发现项只出现一次、`legacy` kind、标题回退、按 `updatedAt` 最新优先、legacy 状态判定）。

`dsh-discovery-persistence.mjs`（Electron ABI 下运行）：投影落库、重启后仍存在、重启前后列表均无重复 — 7 项断言全部 `true`。

### 已验证的 ACP 行为（`@deepseek-ai/dsh@0.1.7-rc.2`）

- `session/new` 创建的 Session 在持久化（如 `session/close`）前不出现在 `session/list`。
- SDK 与 ACP profile 共用单根 DSH home（`$DSH_HOME` → `~/.dsh`）。
- `sessionListPageSize` 可通过 `--patch` 覆盖，用于分页验证。

### 未验证 / 限制

- 未在运行中的应用窗口内目视验证列表与占位样式；仅通过类型检查和探针验证状态与合并逻辑。
- `listSessions` 每次都会启动一个 ACP 子进程（未做缓存），尚未评估冷启动延迟是否符合交互预期。
- 未验证同一 DSH Session 在两个窗口/进程的跨进程独占（属阶段 4；当前 `claimSession` 仍是进程内 Map）。
- `readHistory()` 仍显式不可用；公开 ACP/SDK 无 transcript 读取能力。

---

## 阶段 2 — 真实模型 P0 与恢复：未通过

在具备 `DEEPSEEK_API_KEY` 的环境运行 `node scripts/probes/dsh-runtime-p0.mjs`，输出 `status: "failed"`，脱敏结果：

| 阶段 | 结果 | 关键断言 |
| --- | --- | --- |
| `initialize` | 通过 | — |
| `first-prompt` | 通过 | 响应 55 字符、`assistant/message` 1 个、idle 通知 |
| `sequential-prompt` | 通过 | 同进程第二次 prompt 取回前一次标记（`sequential-context-inherited: true`） |
| `first-close` / `second-close` | 通过 | `close()` 真实 resolve；探针只在 resolve 后记 `passed: true`，失败会记录错误并使总状态失败 |
| `resume-after-restart` | **失败** | `name: "JsonRpcResponseError"`、`code: -32603`、`message: "session \"<id>\" already exists"`（字段由探针从抛出的错误读取，非硬编码） |

一次运行的实测输出（脱敏，退出码 1）：`code` 与 `message` 由 `dsh-runtime-p0.mjs` 直接记录；`first-close`、`second-close` 均为 `passed: true`，即两次 `close()` 都实际成功。诊断探针 `dsh-runtime-diag.mjs` 输出同样字段并在失败时退出码 1。

**根因（公开代码可复核）**：`@deepseek-ai/dsh-sdk-jsonrpc-server` 的 `prompt` 对每个 sessionId 都调用 `ctx.agents.create({ sessionId, meta })`，从不调用 `ctx.agents.resume(...)`。Session 已持久化时 `agents.create` 抛 `already exists`。SDK wire 只有 `initialize` / `session/prompt` / `shutdown`，没有 resume 方法。

**对照验证**：`node scripts/probes/dsh-acp-resume.mjs`（`status` 退出码 0）

```json
{ "create": { "stopReason": "end_turn", "chunkChars": 44 },
  "resume": { "ok": true },
  "resumeContext": { "stopReason": "end_turn", "chunkChars": 19, "hasToken": true } }
```

即：**公开 ACP `session/new` → 关闭 → 新进程 `session/resume` 能正确继承上下文；SDK sdk-profile 不能。**

因为「第一次 Codey 提交沿用原 DSH 上下文」和「重启恢复」都依赖 resume，**本阶段未通过**。`DshRuntime` 现有的按 ID 提交路径对已存在 Session 只会触发上述错误；需架构决策：改走公开 ACP `session/resume` 执行，或等待上游为 SDK wire 增加 resume。

未验证：运行时内部为何在该 id 上走 `create` 分支（探针只观测 JSON-RPC 层错误，不解析私有存储）；cwd 不匹配的失败语义；跨 profile resume 等价性（未测，不作声明）。

---

## 阶段 3 — 正式 Runtime 改用 `HarnessClient`：未运行

依赖阶段 2 的真实模型验证；尚未开始。已确认 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2` 同时导出 `HarnessClient` 与 `DeepSeekHarness`，`DshRuntime.ts` 当前仍使用后者，且 `project()` 仍将普通 `assistant` 事件映射为 `thinking`（待阶段 3 修正）。

---

## 阶段 4 — Windows 安装包验证：未运行

尚未构建 `dist:win`，未验证安装包内 DSH 路径解析、Node 模式启动、真实提交、子进程回收、原 Session 恢复与跨进程独占。

---

## 本次修改文件

- `src/main/dsh/SessionDiscovery.ts`（重写为 ACP 发现）
- `src/main/dsh/sessionMerge.ts`（新增）
- `src/main/WindowController.ts`
- `src/main/persistence/ProductStore.ts`
- `src/shared/contracts.ts`
- `src/renderer/src/main.tsx`
- `scripts/probes/dsh-acp-discovery.mjs`（新增）
- `scripts/probes/dsh-session-discovery-impl.mjs`（新增）
- `scripts/probes/dsh-session-merge.mjs`（新增）
- `scripts/probes/dsh-discovery-persistence.mjs`（新增）
- `scripts/probes/dsh-runtime-p0.mjs`（结构化阶段报告、真实 close 状态、JSON-RPC 错误字段、退出码）
- `scripts/probes/dsh-runtime-diag.mjs`（新增，失败定位；同样记录真实 close 状态与错误字段，失败退出码 1）
- `scripts/probes/dsh-acp-resume.mjs`（新增，ACP resume 对照）
- `docs/dsh-integration-status.md`、`docs/architecture-review.md`、`requirement/dsh-final-system-design.md`（同步 V1 决策与阶段 2 结论）
- `docs/dsh-upstream-resume-report.md`（面向上游的 resume 缺陷报告）
- `.gitignore`（忽略探针缓存）

## 下一步

1. 架构决策：旧 Session 的执行是否改走公开 ACP `session/resume`（已验证可用），或在 SDK wire 增加 resume 前暂缓旧 Session 兼容。
2. 若继续阶段 3：`DshRuntime` 切到 `HarnessClient` 并修正 `assistant → thinking` 误映射；但需明确 resume 仍需上述决策。
3. 阶段 4 打包验证，含跨进程 Session 独占。
