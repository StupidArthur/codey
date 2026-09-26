# Temporal Workspace — 最终系统设计文档

> 版本：V1 Final Design  
> 日期：2026-09-25  
> 范围：桌面 GUI、前端交互、应用后端、DeepSeek Harness（DSH）集成、Plan / Vibe / Loop、Round / Result、持久化与恢复。

> **V1 最终实现状态（2026-09-26）**：V1 已验收关闭。本文最初记录的方案中，凡与本段冲突者均为**已被取代的原始设计**，只保留作决策历史；当前事实以 `docs/v1-acceptance.md` 的 TODO 7 最终关闭记录、`docs/architecture-review.md` 和代码为准。
>
> - Runtime transport：公开 ACP，`dsh --profile acp`；新建 `session/new`，恢复 `session/resume`，每轮 `session/prompt`；发现使用 `session/list(cwd)`。产品不走 `HarnessClient` / `sdk` profile。
> - Persistence：Electron 内置 `node:sqlite` / `DatabaseSync`。`better-sqlite3` 在 Electron 44 下的原生析构崩溃已复现，故不再使用。
> - Window / Session：一个窗口管理一个 Session；同一 Session 通过租约保持独占。
> - Legacy history：没有公开 transcript 读取接口；显示 `Historical transcript unavailable`，不解析私有 JSONL。
> - Plan：产品侧 `PlanGuidance` guidance path；不是 DSH 原生 session mode。权限由 Session sandbox preset 控制。
> - Loop：**model-assessed and product-validated**。模型判断自然语言 Spec 语义覆盖；产品校验引用证据、workspace input fingerprint、known counter-evidence、预算和终态。Markdown parser 不正式证明语义相关性，产品证据也不构成任意语义的形式化证明。
> - workspace-write 下的 tests/typecheck/build 使用产品生成的 nonce wrapper，在 DSH sandbox 中运行；产品读取匹配工件并校验 input fingerprint。
> - Result 汇总整个 Round，不只是最后一条回复。Windows V1 已通过真实安装版验收。

下文中的早期集成方案、验收计划和方案图如与上述状态冲突，均按 **historical / superseded** 阅读。

## 历史设计记录（historical / superseded）

本节以下正文是 V1 开发前/开发中的设计依据和备选方案，不应作为当前实现要求；最终行为以本文开头的实现状态及验收文档为准。

---

## 1. 产品定义

Temporal Workspace 是构建在 DeepSeek Harness（DSH）之上的桌面工作代理产品。

它不是新的 agent runtime，也不复制 DSH 的 Session、Context、Tool、MCP、Sandbox、Model Adapter、Compaction 或原生 agent loop。产品主要解决 DSH 原生能力之上的工作组织与 GUI 表达问题：

- 把一次持续工作的结果组织成可浏览的“时序成果页”；
- 强制用户输入以 Spec 文档的形式存在，即使 Spec 只有一句话；
- 提供 `Plan / Vibe / Loop` 三种用户主动选择的工作方式；
- 为 Loop 增加 Codex-style 的长程控制、验证、继续执行与收敛逻辑；
- 用 Result Builder 把模型输出与实际 workspace 证据合并成可信的结果页；
- 把执行过程作为临时 observability，而不是长期占据主界面的 console。

核心原则：

> **DSH 管运行时和模型上下文；Temporal Workspace 管工作文档、Round、Result 和 GUI。**

---

## 2. V1 的边界

### 2.1 必须复用 DSH 原生能力

以下能力不自行实现：

- DSH Session；
- Session 持久化与恢复；
- Conversation / model context；
- Context compaction；
- Agent loop；
- Tool registry 与工具执行；
- MCP；
- Sandbox；
- Model provider / adapter；
- DSH 原生 Plan Mode 能力（在适用时）；
- Session event stream；
- 原生错误和工具执行事实。

### 2.2 我们自己实现

- Workspace-first 启动体验；
- 单窗口单 Session 的产品模型；
- Round 数据模型；
- Plan / Vibe / Loop 的产品语义；
- Plan revision 文档；
- Vibe conversation page；
- Loop Controller；
- Evidence Collector；
- Result Builder；
- 时序成果页 GUI；
- 临时 TUI-style Runner 卡片；
- Session 级产品配置和 UI 元数据；
- Round / Result / Plan Version / Vibe Entry 的产品持久化。

### 2.3 V1 明确不做

- 不 fork DSH core；
- 不修改 DSH 原生 agent loop；
- 不实现第二套 context manager；
- 不实现第二套 conversation event log；
- 不自建 sandbox；
- 不做 subagent 产品能力；
- 不做 multi-agent；
- 不在一个应用窗口里切换多个 Session；
- 不依赖 DSH package-private / internal API；
- 不要求用户理解 DSH Session ID。

---

## 3. 最终产品层级

产品最终只有以下核心层级：

```text
Application Window / Instance
  └── Workspace Directory
       └── DSH Session
            └── Round
                 ├── Plan Round
                 ├── Vibe Round
                 └── Loop Round
```

没有 `Task` 概念。

### 3.1 一个窗口只管理一个 Session

用户确认采用 VS Code 类似的心智：

> 一个应用实例 / 窗口只打开一个 Session；需要同时处理多个 Session，就打开多个窗口。

产品 UI 不提供“当前窗口内 Session Switcher”。

V1 技术实现可以是同一 Electron 主进程中的多个 BrowserWindow，但产品语义上必须保证：

- 每个窗口只有一个 Session；
- 同一个 DSH Session 同时只能被一个窗口打开；重复打开时聚焦已有窗口；
- 每个窗口有独立的 SessionController；
- 每个窗口的 runtime lifecycle 独立；
- 一个窗口关闭不应隐式切换到另一个 Session；
- 新建第二个工作窗口相当于新的产品实例。

---

## 4. Workspace-first 启动流程

### 4.1 软件刚打开

首页只要求用户先选择 Workspace 目录。

```text
Open Workspace
  ↓
Choose directory
  ↓
Discover sessions belonging to that directory
  ↓
[ Existing Session A ]
[ Existing Session B ]
[ Existing Session C ]
[ + New Session ]
```

这里不再先问“Create Session / Open Session”。

### 4.2 为什么先选择目录

DSH 的 Workspace subsystem 本身以 canonical directory path 作为 Workspace 身份基础，并通过 `SessionHeader.cwd` 验证 Session 与 Workspace 的归属。历史 Session 可以按 cwd / canonical workspace path 归组。

因此用户心智直接定义为：

> “先打开一个目录，再决定继续这个目录里的哪个 Session，或者开始一个新 Session。”

### 4.3 打开已有 Session

步骤：

```text
1. 用户选择目录
2. Canonicalize directory path
3. 查询该目录关联的 DSH root sessions
4. 显示按最近活动排序的 Session
5. 用户选择 Session
6. 打开工作窗口并 resume 该 DSH Session
7. 加载本产品保存的 Round / Result UI 数据
8. 如果有 Temporal Round，默认选择最新成果页；如果没有，且这是已有 DSH Session，则显示只读的 `Historical transcript unavailable` 占位（不伪造 History 内容）
```

用户不需要看到或手动输入 Session ID。

### 4.4 创建新 Session

点击 `New Session` 后：

- 不弹 Session name 表单；
- 不再要求二次配置；
- 直接进入工作区；
- 左侧为空白，无 Result page；
- 右侧 Spec 编辑器可直接输入；
- 默认模式为 `Plan`；
- Session display title 初始可以显示 `New Session`；
- 后续可从第一份 Spec / 第一份成果自动生成显示标题。

第一份 Spec 提交后，才产生第一个 Round。

---

## 5. Session 发现的 DSH 集成边界

### 5.1 当前 DSH 原生事实

截至 2026-09-25，DSH 提供：

- Durable Session persistence；
- Session header 中的 workspace cwd；
- Workspace registry，可按 canonical directory 管理 Session 归属；
- Session controller 的 list / create 等能力；
- ACP 的 `session/list` 支持按 cwd 筛选；
- 官方 TypeScript SDK 用于启动 `dsh --profile sdk` 并驱动 agent turns。

### 5.2 V1 的实现要求

执行路径固定使用官方：

```text
@deepseek-ai/dsh-sdk-client
        ↓
HarnessClient
        ↓
dsh --profile sdk
```

Session discovery 必须同样基于 DSH 的公开能力，不能读取 DSH 私有文件结构作为正式实现。

因为当前 SDK wire protocol 本身是窄协议，主要负责 initialize / prompt / runtime notification，并不是完整 Workspace GUI API，所以 Session Discovery 定义成独立 adapter seam：

```ts
interface SessionDiscoveryAdapter {
  listByWorkspace(canonicalPath: string): Promise<SessionSummary[]>
}
```

V1 优先级：

1. 使用 DSH 正式公开的 host/session listing surface；
2. 若 SDK profile 没有暴露 listing，则使用 DSH 的公开 ACP `session/list` + cwd filter 作为 discovery transport；
3. 绝不直接 import DSH internal implementation；
4. 绝不通过解析 DSH JSONL 文件来形成长期产品耦合。

执行 turn 仍然只由 `HarnessClient` 负责。

---

## 6. 主工作区最终布局

窗口分成三部分：

```text
┌──────────────┬──────────────────────────────┬───────────────────┐
│ Round Sidebar│       Result / Page          │   Spec Editor      │
│              │                              │                   │
│ thumbnails   │  selected latest page       │ Plan Vibe Loop    │
│              │                              │ Source / MD       │
│              │                              │                   │
│ runner mini  │  runner overlay when active │ markdown editor   │
│              │                              │                   │
│              │                              │ End | Submit      │
└──────────────┴──────────────────────────────┴───────────────────┘
```

### 6.1 左侧栏

左侧栏只属于当前 Session：

- Session title / workspace；
- Round thumbnails；
- 最新 Round 默认被选中；
- 可像 ChatGPT 一样折叠；
- 执行卡片收起后进入侧栏底部；
- 侧栏折叠时，Runner 进一步压缩为状态点 / 极简 icon。

### 6.2 中间成果区

中间只显示当前选中的成果页。

不是 Console。

设计原则：

> Console = observability；Document = continuity。

用户可以在 agent 运行时继续浏览任意历史成果页。

### 6.3 右侧 Spec 区

右侧永远是输入窗口，不显示 Session metadata 卡片，不改成 Result panel。

顶部一行：

```text
[ Plan ] [ Vibe ] [ Loop ]           [ 源码 ] [ MD ]
```

下面整块是 Markdown Spec editor。

底部只有两个同宽按钮：

```text
[ 结束当前轮次 ] [ 提交 ]
```

不额外放解释文字，避免增加界面密度。

---

## 7. Markdown 输入设计

右侧 Spec 是一份 Markdown 文档。

### 7.1 不定义强制 Spec schema

Spec 可以是：

- 一句话；
- 一段普通文字；
- 完整 Markdown；
- 带标题、约束、验收条件的复杂文档。

V1 不要求固定字段。

```ts
type Spec = {
  markdown: string
}
```

### 7.2 Source / MD

- `源码`：Markdown 源码编辑；
- `MD`：渲染预览；
- 二者共享同一数据；
- 默认可以使用用户上一次视图偏好；若没有偏好，默认源码编辑。

---

## 8. Round 的最终定义

Round 不是一次模型请求。

Round 是用户感知上的“一段连续工作”。

```ts
type RoundMode = 'plan' | 'vibe' | 'loop'

type RoundStatus =
  | 'active'
  | 'completed'
  | 'partial'
  | 'blocked'
  | 'budget_exhausted'
  | 'failed'
```

产品 Session 中是一串 Round：

```text
Session
  → Round
  → Round
  → Round
```

Round 内部可以对应一个或多个 DSH prompt / turn。

---

## 9. Mode 切换与 Round 边界

用户主动选择 Plan / Vibe / Loop，产品不自动替用户判断模式。

### 9.1 总规则

```text
Plan → Plan → Plan = 同一个 Plan Round
Vibe → Vibe → Vibe = 同一个 Vibe Round
Loop submit          = 一个独立 Loop Round
```

当用户从 Plan/Vibe 切到其他模式：

```text
close current Plan/Vibe Round
→ switch mode
→ next submit starts a new Round
```

`结束当前轮次`：

- Plan：finalize 当前 Plan Round；
- Vibe：finalize 当前 Vibe Round 并生成顶部 Result；
- Loop：正常情况下 Round 在运行完成时已经结束，因此按钮不承担 Loop finalize；
- 有执行正在进行时，V1 不把此按钮当作“cancel running prompt”。

---

## 10. Plan Mode

### 10.1 用户体验

第一次 Plan 提交：

```text
Spec 1
→ DSH planning
→ Plan v1
→ create Plan Round
```

后续仍为 Plan：

```text
feedback / revised spec
→ DSH planning
→ Plan v2
→ same Plan Round
```

继续：

```text
feedback
→ Plan v3
→ same Plan Round
```

缩略图只显示当前最新版 Plan，但历史版本全部保留。

### 10.2 Plan 页数据

```ts
interface PlanRound extends RoundBase {
  mode: 'plan'
  versions: PlanVersion[]
  latestVersionId: string
}

interface PlanVersion {
  id: string
  submittedSpec: string
  planMarkdown: string
  createdAt: string
  dshActivityRef?: string
}
```

### 10.3 Plan 与 DSH 原生 Plan Mode

优先复用 `@deepseek-ai/dsh-plan-mode` 的原生 planning guidance / collaboration state，而不是我们自己创造另一个 agent planning loop。

注意：DSH Plan Mode 是 soft guidance，不是权限边界。真正限制写入仍由 Sandbox / Permission policy 单独执行。

如果产品定义 Plan 为“规划阶段默认不修改 workspace”，则需要配合 Session / Turn 级 sandbox policy 进行实际限制，不能只依赖 Plan prompt。

---

## 11. Vibe Mode

### 11.1 用户体验

连续 Vibe 不产生多个成果页，而是不断追加到同一个 Vibe Round。

```text
User input 1
Agent output 1

User input 2
Agent output 2

User input 3
Agent output 3
```

左侧成果页是一个持续增长的 conversation document。

### 11.2 Vibe Round 数据

```ts
interface VibeRound extends RoundBase {
  mode: 'vibe'
  entries: VibeEntry[]
  result?: ResultDocument
}

interface VibeEntry {
  id: string
  specMarkdown: string
  assistantOutput: string
  createdAt: string
  executionOutcome: ExecutionOutcome
}
```

### 11.3 Vibe Round 结束

触发条件：

- 用户点击 `结束当前轮次`；或
- 用户切换到 Plan / Loop。

结束时调用 Result Builder，在现有 conversation document 顶部加入：

```text
Summary
Changes
Verification
Remaining   // only if needed
```

下面保留完整 Vibe conversation。

所以最终 Vibe page：

```text
Result
  Summary
  Changes
  Verification
  Remaining?

Conversation
  user
  agent
  user
  agent
  ...
```

---

## 12. Loop Mode

Loop 是 V1 的主要差异化能力。

### 12.1 定义

Loop 是一次用户提交触发的一次长程 Round。

用户只看到一个 Round，但内部可以有多个 DSH prompts / continuations。

```text
Root Spec
  ↓
execute
  ↓
collect evidence
  ↓
verify
  ↓
evaluate gap
  ├─ complete
  ├─ continue(nextPrompt)
  ├─ blocked
  └─ stop
```

### 12.2 Loop state

V1 对所有 Loop 使用同一套默认预算，不按任务类型自动调整：

```text
max internal continuations: 16
max wall time:              2 hours
max consecutive no-progress: 3
max same-error retries:       2
```

这些参数暂不出现在主界面；未来可放入 Advanced Settings。内部 continuation 次数只统计第一次执行之后的继续执行。

```ts
interface LoopState {
  roundId: string
  rootSpec: string
  status:
    | 'active'
    | 'completed'
    | 'blocked'
    | 'budget_exhausted'
    | 'failed'
  budget: LoopBudget
  evidence: EvidenceSnapshot[]
  lastResult?: ExecutionResult
  continuationCount: number
}
```

### 12.3 Loop decision

```ts
type LoopDecision =
  | { action: 'complete'; reason: string }
  | { action: 'continue'; nextPrompt: string }
  | { action: 'blocked'; reason: string }
  | { action: 'stop'; reason: 'budget' | 'failure' }
```

不单独增加 `replan` runtime state。

重新规划只是某次 `continue.nextPrompt` 的内容不同。

### 12.4 主循环

```ts
while (state.status === 'active') {
  const execution = await dshRuntime.run(nextPrompt)
  const evidence = await evidenceCollector.collect(execution)
  const decision = await loopEvaluator.evaluate({
    rootSpec,
    state,
    execution,
    evidence,
  })

  applyDecision(state, decision)
}
```

### 12.5 停止语义

Loop 只能因为以下理由结束：

1. **completed**：同时满足以下四项，并有足够证据支持；
2. **blocked**：需要用户输入、超权限操作或外部依赖；
3. **budget_exhausted**：达到 V1 的 continuation 或 wall-time 上限；
4. **failed**：连续 3 次无进展、同一错误重试 2 次后仍失败，或出现不可恢复错误。

`completed` 的四项必要条件：

1. Spec 中明确要求的事项已经完成；
2. 没有已知的 required item 仍未完成；
3. 有与本次任务匹配的 Verification evidence；
4. 当前 workspace 没有已知会推翻完成结论的问题。

**Loop completion is model-assessed and product-validated.** 模型判断完整自然语言 Spec 的语义覆盖；产品验证 cited evidence、workspace input fingerprint、known counter-evidence、budget 和 terminal status。workspace-write 下相关 tests/typecheck/build 通过产品生成的 nonce wrapper 在 DSH sandbox 内运行，产品读取匹配工件并校验 input fingerprint。Markdown parser 不正式证明 semantic relevance，product evidence 也不是对任意语义的形式化证明。模型一句“完成了”不能单独触发 `completed`。

证据不足时不得判定 `completed`；应根据剩余工作和停止条件进入 `continue`、`blocked`、`budget_exhausted` 或 `failed`。最终 Result 必须明确显示实际停止状态和原因，尤其不能将 `budget_exhausted` 包装成完成。

### 12.6 用户视图

内部 continuation 不变成顶层 Round，也不变成左侧多个缩略图。

一个 Loop submit → 一个 Loop Round → 一个最终 Result page。

---

## 13. Result Contract

最终统一结果结构：

```text
Result

Summary
Changes
Verification
Remaining   ← 有内容才显示
```

Loop Result 在上述正文之前显示终止状态与具体原因（`completed` / `blocked` / `budget_exhausted` / `failed`）。这是结果元数据，不增加第五个正文 section；非 `completed` 状态不能使用暗示任务已完成的标题或措辞。

### 13.1 Summary

说明最终完成了什么。

可以包含关键实现决策，但不是执行日志。

### 13.2 Changes

实际发生的变化：

- code；
- files；
- configuration；
- docs；
- artifacts；
- behavior。

### 13.3 Verification

只能写可验证事实：

- tests；
- typecheck；
- lint；
- build；
- manual validation；
- workspace inspection。

模型仅说“测试通过”不能直接成为事实。

### 13.4 Remaining

仅在确实存在时显示：

- unfinished work；
- known risk；
- blocker；
- intentional follow-up。

禁止为了格式完整而渲染空 section。

---

## 14. Result Builder

Result Builder 不能只让模型根据自己的最后一条回复生成总结。

### 14.1 输入证据

```text
DSH final response
+ actual changed files / git diff
+ verification evidence
+ generated artifacts
+ execution outcome / status
→ Result Builder
```

### 14.2 默认不输入

不要默认把以下所有信息全部塞给 Result Builder：

- 所有 tool calls；
- 全量 console log；
- 全量模型消息；
- 完整 Session event log。

这些属于 DSH 的运行历史和 debug 信息。

### 14.3 Evidence Collector

```ts
interface EvidenceCollector {
  collect(input: {
    workspace: string
    executionWindow: ExecutionWindow
  }): Promise<EvidenceBundle>
}
```

`EvidenceBundle` 建议包含：

```ts
interface EvidenceBundle {
  changedFiles: ChangedFile[]
  gitDiffSummary?: string
  verification: VerificationRecord[]
  artifacts: ArtifactRecord[]
  executionOutcome: ExecutionOutcome
}
```

### 14.4 Result Builder 的原则

> Result 是“结果与证据的投影”，不是“运行过程的摘要”。

---

## 15. Runner / 运行悬浮卡片

### 15.1 出现条件

Runner 在**没有执行时完全不显示**。

只有用户 Submit 后才出现。

### 15.2 展示内容

风格类似 TUI：

```text
● Running · Loop

thinking  inspecting current state…
tool      read src/auth/controller.ts
tool      edit src/auth/service.ts
thinking  checking remaining gap…
verify    tests passed
```

这里只显示适合用户观察的流式执行事件：

- reasoning / progress summary；
- tool invocation；
- tool completion；
- verification；
- blocked / error state。

不需要把所有原始 token / protocol frame 暴露给用户。

### 15.3 Runner 展开态

Runner 浮在中间成果区之上。

它不能把成果页替换掉。

这意味着 agent 工作时用户仍可以：

- 查看旧 Round；
- 切换缩略图；
- 阅读 Result；
- 在右边继续编辑下一份 Spec。

### 15.4 Runner 收起态

点击收起：

```text
Floating Runner
→ Sidebar bottom Runner Mini
```

左侧栏打开：

```text
● Loop running
  4 tools · 2m
```

左侧栏折叠：

```text
●
```

点击 Mini Runner 恢复浮窗。

### 15.5 运行时右侧 Spec

执行中右侧 Spec 仍然可编辑。

V1 建议：

- editor 可编辑；
- Submit 暂时 disabled，直到当前 DSH activity idle；
- 用户写好的下一份 Spec 保留；
- 不在 V1 实现复杂的并发 prompt queue。

---

## 16. DSH Runtime Integration

### 16.1 固定选择

V1 使用官方 TypeScript package：

```text
@deepseek-ai/dsh-sdk-client
```

Windows 安装包同时内置版本匹配的 DSH 运行时；用户不需要预装 DSH。首发平台为 Windows，macOS 后续支持。DSH 与 SDK 必须锁定匹配版本，并在安装包中验证子进程启动与升级兼容。

核心使用：

```text
HarnessClient
```

而不是：

- 自己实现 JSON-RPC framing；
- 自己解析 stdout；
- 直接 import DSH internal runtime packages；
- 把 `headless` 命令当主要架构。

### 16.2 Runtime lifecycle

每个打开 Session 的应用窗口拥有一个长期 runtime adapter：

```text
Window
  ↓
DshRuntimeAdapter
  ↓
HarnessClient
  ↓
dsh --profile sdk child process
```

官方 SDK client 自己负责：

- spawn；
- initialize handshake；
- JSON-RPC transport；
- typed protocol errors；
- notification subscription；
- child-process teardown。

### 16.3 Session resume

产品保存 `dsh_session_id`。

已有 Session：

```text
workspace selected
→ session selected
→ create HarnessClient
→ initialize runtime with cwd/model config
→ attach/open named session
→ subscribe session notifications
→ render stored Round metadata
```

对于从未被 Temporal Workspace 使用过、没有产品 Round 数据的旧 DSH Session：

```text
左侧：Existing DSH Session（无 Temporal Round）
右侧：空 Spec，默认 Plan
中间：只读占位 `Historical transcript unavailable`
Temporal Round 数量：0
```

旧 DSH 历史只读继承，不重建旧 Plan、Vibe、Loop 或 Round，也不把旧历史写入产品 Round 表。**当前公开 SDK wire 与 ACP `session/list` 只提供 Session 的发现与 resume，不提供 transcript/消息读取**（`session/load` 不受支持，旧更新不回放）。因此该占位明确声明旧历史不可读，而不是伪造或倒推内容；`Temporal structure begins from the first submission made through this product.`

第一次 Temporal 提交必须在原有 `dsh_session_id` 上继续，使 DSH 原生 conversation/context 自然衔接；产品不重新向模型注入旧历史。该提交创建 Round 1。此后左侧时间线为 `Round 1 → Round 2 → …`。

新 Session：

```text
workspace selected
→ New Session
→ open blank workspace UI
→ lazily create/obtain DSH session on first submit
→ persist returned dsh_session_id
```

是否在进入空页面时立刻创建 DSH Session，V1 可采用 lazy create，以避免用户打开后未提交便留下空 Session。

---

## 17. 当前 SDK 的重要限制

当前官方 TypeScript SDK 文档明确：SDK wire 当前没有 mid-turn cancel。

因此 V1 不把 `结束当前轮次` 设计成运行期 Cancel。

### 17.1 V1 语义

- `结束当前轮次`：Round 边界操作；
- 当前 execution active 时 disabled；
- 如果以后需要 Stop，需要单独设计 `Stop execution`；
- 当前 SDK 下 hard stop 只能通过关闭 runtime 等更重的方式实现，不应伪装成轻量 cancel。

这条必须写进开发验收，避免前端按钮语义与 runtime 能力不一致。

---

## 18. Session / Context 归属

### 18.1 DSH 是对话事实来源

以下数据以 DSH Session 为权威：

- conversation events；
- agent messages；
- tool events；
- model context；
- compaction；
- replay / resume；
- raw execution history。

我们不维护第二份完整 conversation log。

### 18.2 产品 store 只保存产品投影

我们需要保存的是 DSH 不知道的产品概念：

- Round grouping；
- Plan versions；
- Vibe entries 对应关系；
- Result documents；
- selected round；
- permission preference；
- auto-generated display title；
- Loop budgets / terminal status；
- evidence index / artifact references。

---

## 19. 产品数据模型

建议 V1 使用 app-local SQLite。

不要默认在用户 repo 内创建 `.temporal-workspace` 文件，避免污染源码仓库。

### 19.1 Session UI record

```ts
interface ProductSession {
  id: string
  dshSessionId?: string
  workspacePath: string
  displayTitle: string
  permission: PermissionPreset
  createdAt: string
  updatedAt: string
}
```

### 19.2 Round base

```ts
interface RoundBase {
  id: string
  productSessionId: string
  sequence: number
  mode: 'plan' | 'vibe' | 'loop'
  status: RoundStatus
  createdAt: string
  closedAt?: string
}
```

### 19.3 Result document

```ts
interface ResultDocument {
  summary: string
  changes: ResultItem[]
  verification: VerificationRecord[]
  remaining?: ResultItem[]
  loopTerminal?: {
    status: 'completed' | 'blocked' | 'budget_exhausted' | 'failed'
    reason: string
  }
}
```

### 19.4 DSH correlation

每次内部执行可保存轻量引用：

```ts
interface DshActivityRef {
  sessionId: string
  promptMessageId?: string
  startedAt: string
  endedAt?: string
}
```

不复制完整 event payload。

---

## 20. Permission / Sandbox

模型 Provider、Model、Base URL 与凭证由本产品提供配置入口。凭证使用操作系统安全存储能力，不以明文写入产品 SQLite；DSH 子进程只接收本次运行需要的配置。

权限是 Session 级配置项。

默认：

```text
workspace-write
```

可配置为 DSH 支持的其他 sandbox / permission preset。

原则：

- mode 不自动提升权限；
- Loop 也只能在 Session 的权限边界内运行；
- 超出权限 → blocked；
- 不 silent escalation；
- Plan Mode 的“只规划”不等于 sandbox 限制，真正的写权限必须由 sandbox/policy 控制。

---

## 21. 前端技术架构

V1 推荐：

```text
Electron
React
TypeScript
```

理由：

- 官方 DSH SDK 是 TypeScript / Node friendly；
- 需要启动本地 `dsh` child process；
- 需要 directory picker；
- 需要桌面多窗口；
- 需要文件系统和 workspace inspection；
- macOS-like UI 易实现；
- V1 工程复杂度最低。

### 21.1 Renderer 组件

```text
AppShell
├── TitleBar
├── RoundSidebar
│   ├── SessionHeader
│   ├── RoundThumbnailList
│   └── RunnerMini
├── ResultViewport
│   ├── EmptyState
│   ├── PlanRenderer
│   ├── VibeRenderer
│   ├── LoopResultRenderer
│   └── RunnerOverlay
└── SpecPanel
    ├── ModeSelector
    ├── MarkdownViewToggle
    ├── MarkdownEditor
    └── RoundActions
```

### 21.2 Renderer state

建议 Zustand / equivalent lightweight store，不需要复杂 Redux architecture。

主要状态：

```ts
interface WindowState {
  workspacePath: string
  productSessionId: string
  dshSessionId?: string
  rounds: RoundSummary[]
  selectedRoundId?: string
  selectedMode: RoundMode
  draftSpec: string
  markdownView: 'source' | 'rendered'
  runner: RunnerProjection
  sidebarCollapsed: boolean
}
```

---

## 22. Desktop backend / main-process architecture

Electron main process负责本地高权限能力。

```text
Desktop Main Process
├── WindowManager
├── WorkspaceService
├── SessionDiscoveryService
├── ProductStore
├── SessionController (per window)
│   ├── DshRuntimeAdapter
│   ├── RoundEngine
│   ├── PlanController
│   ├── VibeController
│   ├── LoopController
│   ├── EvidenceCollector
│   ├── ResultBuilder
│   └── RunnerProjector
└── IPC Router
```

### 22.1 WindowManager

职责：

- 创建空启动窗口；
- 打开 Workspace；
- 打开已有 Session；
- 创建新 Session window；
- 保证单窗口单 Session；
- 第二个 Session 使用新窗口。

### 22.2 WorkspaceService

职责：

- directory picker；
- canonical path；
- 校验 directory exists；
- 调 SessionDiscoveryAdapter。

### 22.3 SessionController

每个窗口一个。

生命周期：

```text
init
→ attach/create DSH session
→ idle
→ run
→ project events
→ build/update round
→ idle
→ dispose
```

---

## 23. IPC contract

Renderer 不直接访问 DSH SDK。

建议 IPC：

```ts
workspace.chooseDirectory()
workspace.listSessions(path)

session.open({ workspacePath, dshSessionId })
session.create({ workspacePath })
session.getSnapshot()

round.submit({ mode, specMarkdown })
round.endCurrent()

runner.subscribe()
runner.expand()
runner.minimize()

spec.saveDraft(markdown)
settings.setPermission(preset)
```

所有 DSH process / filesystem / git 操作都在 main process。

---

## 24. Round Engine

RoundEngine 负责把用户 submit 映射为产品 Round，而不是复制 agent loop。

```ts
class RoundEngine {
  submit(mode: RoundMode, spec: string): Promise<void>
  endCurrent(): Promise<void>
}
```

### 24.1 Submit routing

```text
Plan
  ├─ current open Plan round → append revision
  └─ otherwise → create Plan round

Vibe
  ├─ current open Vibe round → append entry
  └─ otherwise → create Vibe round

Loop
  └─ always create one new Loop round
```

---

## 25. Runner event projection

Runner 不是 raw DSH event viewer，而是 projection。

```ts
interface RunnerEvent {
  kind: 'thinking' | 'tool' | 'verify' | 'status' | 'error'
  text: string
  timestamp: string
}
```

`RunnerProjector` 从 DSH notification stream 中挑选有用户价值的事件。

原则：

- 忠于事实；
- 尽量短；
- 不泄漏 protocol 噪声；
- 不作为长期持久主文档；
- 运行完成后默认消失。

调试模式以后可以提供完整 raw event inspector，但不是 V1 主界面。

---

## 26. Verification 与 workspace inspection

EvidenceCollector 必须检查实际 workspace。

推荐策略：

1. execution 前记录 git/workspace baseline；
2. execution 后读取 changed files；
3. 若有 git repo，采集 `git diff --stat` / scoped diff evidence；
4. 从 DSH tool events 中采集测试命令与 exit status；
5. 对生成 artifact 记录路径和存在性；
6. 交给 Result Builder。

不要把 Git 当成必须依赖：非 Git workspace 也要工作。

---

## 27. Result Builder 技术流程

```text
DSH idle
  ↓
collect final assistant response
  ↓
collect workspace evidence
  ↓
collect verification records
  ↓
collect artifacts
  ↓
compose structured evidence prompt
  ↓
Result Builder model call
  ↓
validate result schema
  ↓
persist ResultDocument
  ↓
render page
```

Result Builder 输出需要 schema validation。

如果 Builder 说某项 verification passed，但 evidence 中没有事实，则丢弃该 verification，不能展示。

---

## 28. Plan Result Builder

Plan 模式结束后的主要产物是 Plan 本身。

不需要强制再套一层复杂 Result。

Plan Round 页以最新版 Plan 为主，版本历史可访问。

如果需要额外 metadata，可作为页面 chrome，而不是加入正文。

---

## 29. Vibe Result Builder

Vibe 每次提交后，不需要立即生成完整 Result。

只记录：

```text
spec
assistant output
evidence / execution outcome
```

当 Round finalize 时，一次性对整个 Vibe Round 生成：

```text
Summary / Changes / Verification / Remaining
```

并插到 conversation 顶部。

---

## 30. Loop Result Builder

Loop terminal 后立即生成完整 Result。

Result Builder 必须保留 Loop 的真实 terminal status 与 reason，并在结果页顶部显示。`budget_exhausted`、`blocked` 或 `failed` 时，即使已有部分成果，也只能描述为部分成果并列出 Remaining。

Loop evaluator 和 Result Builder 可以共享 EvidenceBundle，但角色不同：

- Evaluator：判断是否继续；
- Result Builder：把最终成果写成用户可读文档。

不要用 Result Builder 的 prose 反过来作为 Loop 完成事实来源。

---

## 31. Error / Recovery

### 31.1 Runtime transport error

- Runner 显示 error；
- Round → failed / partial；
- draft Spec 保留；
- ProductStore flush；
- RuntimeAdapter dispose；
- 提供重新连接/重试入口。

### 31.2 App crash

重启后：

1. 选择 Workspace；
2. 打开 DSH Session；
3. DSH 恢复自己的持久 session；
4. ProductStore 恢复 Round projection；
5. 如果发现某 Round 上次状态为 active 但没有 terminal record，则标记为 `interrupted`/`partial` 并重新 reconcile。

### 31.3 Product DB 与 DSH 不一致

DSH 对话日志是真实运行事实。

产品 projection 可以修复，但不能覆盖 DSH history。

需要一个 `reconcileSession()` maintenance path：

- 检查 dsh_session_id 是否存在；
- 检查 workspace cwd 是否匹配；
- 检查 dangling active Round；
- 不尝试自动重建所有历史 Round 语义。

---

## 32. Session title

不让用户创建 Session 时填写名字。

Display title 是辅助 UI metadata：

优先级：

```text
manual rename (future)
> generated title from first meaningful Spec / Result
> workspace folder name + timestamp
> New Session
```

它不参与 DSH Session identity。

---

## 33. 多窗口行为

当已有一个 Session 窗口时，用户要处理另一个 Session：

```text
File → New Window
or
Open Workspace in New Window
```

新的窗口重新走：

```text
select workspace
→ choose session / new session
```

V1 不做窗口间共享运行队列。

每个窗口独立拥有 runtime adapter。

---

## 34. 前端关键 UX 状态

### 34.1 New Session / no Round

```text
Sidebar: empty
Result View: empty state
Mode: Plan
Spec: blank markdown
Runner: hidden
```

旧 DSH Session 没有 Temporal Round 时是单独的兼容状态：左侧显示 `Existing DSH Session`，中间显示只读占位 `Historical transcript unavailable`，右侧为空 Spec 且默认 Plan；第一次提交沿用原 DSH Session 并创建 Round 1。

### 34.2 Idle with results

```text
Sidebar: rounds
Result View: latest selected by default
Spec: editable draft
Runner: hidden
```

### 34.3 Running

```text
Sidebar: rounds
Result View: still browsable
Runner: overlay visible or minimized into sidebar
Spec: editable
Submit: disabled
End Round: disabled
```

### 34.4 Finished

```text
Runner: disappears
Round page: created/updated
Sidebar: latest selected
Spec draft: policy-dependent clear/preserve
Submit: enabled
```

建议 submit 完成后清空成功提交的 draft；如果用户在 execution 期间继续编辑过下一份 Spec，则通过 draft revision id 防止误清空新内容。

---

## 35. Draft race handling

这是实际实现必须处理的细节。

用户提交 Spec A 后，agent 在运行；用户开始编辑 Spec B。

运行结束不能把 Spec B 清掉。

方案：

```ts
submitRevision = draftRevision

onComplete:
  if currentDraftRevision === submitRevision:
      clearDraft()
  else:
      preserveCurrentDraft()
```

---

## 36. V1 安全与权限规则

- 默认 `workspace-write`；
- permission per Session；
- 权限变化通过 DSH 支持的 sandbox / policy 配置落地；
- Loop 不自动提升；
- blocked 状态明确告诉用户缺什么；
- 不隐藏危险执行；
- Runner 展示关键 tool activity；
- Result 只声明实际验证过的事实。

---

## 37. 建议目录结构

```text
apps/desktop/
  src/main/
    windows/
    ipc/
    workspace/
    session-discovery/
    dsh/
    rounds/
    loop/
    evidence/
    result-builder/
    persistence/

  src/renderer/
    app/
    sidebar/
    result/
    spec/
    runner/
    markdown/
    state/

packages/domain/
  session.ts
  round.ts
  result.ts
  evidence.ts
  loop.ts

packages/test-fixtures/
  dsh-events/
  workspaces/
```

---

## 38. 核心 TypeScript 接口

```ts
interface DshRuntimeAdapter {
  start(config: RuntimeConfig): Promise<void>
  attachSession(sessionId?: string): Promise<string>
  prompt(input: string): Promise<ExecutionReceipt>
  subscribe(listener: (event: DshEvent) => void): Unsubscribe
  waitForIdle(): Promise<ExecutionResult>
  close(): Promise<void>
}

interface RoundEngine {
  submit(mode: RoundMode, specMarkdown: string): Promise<RoundMutation>
  endCurrent(): Promise<RoundMutation | null>
}

interface LoopController {
  run(round: LoopRound, rootSpec: string): Promise<LoopTerminalState>
}

interface ResultBuilder {
  build(input: ResultBuildInput): Promise<ResultDocument>
}

interface ProductStore {
  loadSession(id: string): Promise<ProductSessionSnapshot>
  saveRound(round: Round): Promise<void>
  saveResult(roundId: string, result: ResultDocument): Promise<void>
  saveDraft(sessionId: string, draft: Draft): Promise<void>
}
```

---

## 39. 测试策略

### 39.1 Unit

- Round routing；
- Plan revision append；
- Vibe append/finalize；
- Loop decision application；
- Result evidence validation；
- draft revision race；
- Runner event projection。

### 39.2 Integration

- HarnessClient start / close；
- create/resume DSH Session；
- prompt → notifications → idle；
- workspace session discovery；
- permission mapping；
- process crash recovery。

### 39.3 End-to-end

必须覆盖：

1. 新目录 → New Session → Plan first submit；
2. Plan 连续 3 次 → 只有一个 Round，3 个版本；
3. Plan → Vibe → Plan 自动结束；
4. Vibe 连续提交 → 一个 page 累积 conversation；
5. End Vibe → 顶部生成 Result；
6. Loop → 多 continuation → 一个 Result page；
7. Runner 展开 → 收起到 sidebar → sidebar collapse；
8. 运行期间编辑下一 Spec → completion 不丢 draft；
9. app restart → resume Session + Round pages；
10. 同时打开两个窗口，各自运行不同 Session。

---

## 40. V1 完成定义

V1 可以认为完成，当以下体验完整闭环：

```text
Open app
→ choose directory
→ list directory sessions
→ choose existing OR New Session
→ enter single-session workspace
→ write Spec
→ choose Plan/Vibe/Loop
→ Submit
→ see transient Runner events
→ minimize Runner into sidebar if desired
→ execution finishes
→ left page is created/updated correctly
→ continue another Round
→ quit and reopen
→ session and product pages resume correctly
```

如果这个闭环成立，就已经是完整产品，而不是一个 DSH GUI wrapper。

---

## 41. 已冻结的产品决策

以下决策视为当前 V1 baseline，不应在开发中无故重新设计：

1. 单窗口单 Session；多 Session = 多窗口。
2. 启动先选目录，再显示该目录 Session + New Session。
3. New Session 不填写名字，直接进入空白工作区。
4. New Session 默认 Plan。
5. 左侧栏是当前 Session 的 Round thumbnails，可折叠。
6. 默认显示最新 Round。
7. 右侧永远是 Spec 编辑器。
8. Plan/Vibe/Loop 与 Source/MD 同一工具行。
9. End Round / Submit 等宽，无额外提示文案。
10. Runner 平时完全隐藏，只在运行时出现。
11. Runner 是中间区域浮窗，不阻止浏览旧成果。
12. Runner 收起进入 Sidebar；Sidebar 折叠时继续极简缩略。
13. Plan 连续提交属于一个 Round，保留版本历史。
14. Vibe 连续提交属于一个 Round，保存完整 conversation。
15. Vibe finalize 后顶部生成 Result。
16. Loop 一次 Submit = 一个长程 Round。
17. Loop 内部 continuation 不成为顶层 Round。
18. Result contract 固定为 Summary / Changes / Verification / Remaining?。
19. Verification 必须来自实际证据。
20. DSH 负责 Session / Context / Agent runtime；我们不复制。
21. 使用官方 TypeScript SDK + HarnessClient。
22. V1 无 subagent 产品能力。
23. V1 无 mid-turn soft cancel 假象。
24. 权限是 Session 级，默认 workspace-write。
25. Loop 默认最多 16 次内部 continuation、2 小时；连续 3 次无进展或同一错误重试 2 次后停止。
26. Loop completed 必须满足 Spec、required items、相关 Verification evidence 和 workspace 状态四项条件；Result 显示真实停止原因。
27. 旧 DSH 历史只读继承，不重建旧 Round；第一次 Temporal 提交在原 Session 上创建 Round 1。
28. Windows 首发；安装包内置与 SDK 同版本的 DSH。
29. 产品内提供模型与凭证配置；同一个 DSH Session 只能被一个窗口打开。

---

## 42. DSH 技术依据（2026-09-25 核验）

以下内容用于说明外部依赖边界，后续升级 DSH 时应重新核验：

- TypeScript SDK family 与 HarnessClient：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md
- SDK package map：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/README.md
- SDK protocol：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md
- DSH Workspace subsystem：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/workspace.md
- DSH Session subsystem：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md
- DSH Session persistence：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md
- DSH Plan Mode：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/plan.md
- ACP session/list（可作为公开 Session discovery fallback）：  
  https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md

---

# Final Architecture Snapshot

```text
┌──────────────────────── Electron Window ────────────────────────┐
│ one window = one workspace + one DSH session                    │
│                                                                  │
│  React Renderer                                                  │
│  ┌──────────┬──────────────────────┬───────────────────────────┐ │
│  │ Rounds   │ Result/Page          │ Spec                      │ │
│  │          │ + Runner overlay     │ Plan Vibe Loop            │ │
│  │          │                      │ Source / MD               │ │
│  │ runner   │                      │ editor                    │ │
│  │ mini     │                      │ End / Submit              │ │
│  └──────────┴──────────────────────┴───────────────────────────┘ │
│                             │ IPC                                │
│  Electron Main             ▼                                    │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ SessionController                                          │ │
│  │  ├─ RoundEngine                                            │ │
│  │  ├─ PlanController                                         │ │
│  │  ├─ VibeController                                         │ │
│  │  ├─ LoopController                                         │ │
│  │  ├─ EvidenceCollector                                      │ │
│  │  ├─ ResultBuilder                                          │ │
│  │  └─ ProductStore                                           │ │
│  │                                                             │ │
│  │ DshRuntimeAdapter → HarnessClient → dsh --profile sdk      │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

一句话总结：

> **DSH 是执行内核；Temporal Workspace 把连续 agent 工作变成可编辑 Spec、可观察运行过程和可回看的时序成果文档。**
