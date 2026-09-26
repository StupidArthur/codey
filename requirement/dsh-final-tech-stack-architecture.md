# DSH Temporal Workspace
# 技术栈与工程架构定稿

> 版本：V1  
> 定位：Windows 优先，同时支持 macOS  
> 状态：已定稿

> **V1 最终实现状态（2026-09-26）**：V1 已验收关闭。下文原始技术方案与最终事实冲突的部分均标记为 **historical / superseded**，保留用于解释决策，不是当前实现要求。当前事实以 `docs/v1-acceptance.md` TODO 7、`docs/architecture-review.md` 和代码为准。
>
> 当前栈：Electron + React + TypeScript + Vite；公开 ACP (`dsh --profile acp`) 统一负责新建、恢复、prompt 和 `session/list(cwd)`；Electron `node:sqlite` / `DatabaseSync` 持久化；一个窗口管理一个 Session；Plan 使用产品侧 guidance path；Loop completion 为 **model-assessed and product-validated**；workspace-write 验证由 nonce wrapper 在 DSH sandbox 中执行并校验 input fingerprint；Result 覆盖整个 Round；Windows 安装版已验收。
>
> 方案分歧原因：SDK resume 缺口由公开 ACP `session/resume` 解决；`better-sqlite3` 在 Electron 44 的原生析构 abort 已被隔离复现，故改用内置 SQLite；DSH 公开 ACP 未提供产品可用 session mode，故 Plan 用产品 guidance path 实现；Windows GUI 子进程的 `0xC0000142` 通过 `WindowsRuntimeHost` 的 runtime-scoped 隐藏 console 初始化处理。以上均有最终验收证据。

## 历史技术方案（historical / superseded）

以下详细方案描述 V1 开发前的选型与候选实现。与本文开头“V1 最终实现状态”冲突的内容仅保留为设计历史，不能用于当前实现判断。

---

## 1. 结论

V1 技术栈正式定为：

```text
Electron
React
TypeScript
Vite
CodeMirror 6
react-markdown + remark-gfm
SQLite
Electron IPC
pnpm
electron-builder
公开 ACP (`dsh --profile acp`)
```

核心原则：

- 一个应用实例只管理一个 Session。
- 多 Session 通过多个应用窗口 / 多实例解决，类似 VS Code。
- 不建设传统 Web 后端。
- Electron Main Process 即本地 Backend。
- Renderer 只负责 UI、交互和展示。
- 所有 DSH 进程、Session、Loop、Result Builder、文件系统、SQLite 操作都在 Main Process。
- DSH 通过公开 ACP 接入；`session/new` / `session/resume` / `session/prompt` 为统一执行路径，`session/list(cwd)` 用于发现。
- Windows 为第一优先平台，macOS 为第二平台。
- V1 不使用 Tauri，不引入 Rust 后端。

---

## 2. 为什么选择 Electron

### 2.1 与 DSH 技术栈天然一致

DSH 官方 SDK 是 TypeScript / Node.js 客户端，产品运行时需要：

```text
Electron Main
    ↓
HarnessClient
    ↓
dsh --profile sdk
    ↓
stdio JSON-RPC
```

Electron Main 本身就是 Node.js 环境，因此：

- 无需额外语言桥接。
- 无需把 DSH SDK 包装成 HTTP 服务。
- 无需 Rust ↔ Node 通信层。
- 子进程管理、stdio、文件系统、Git、SQLite 都可以直接在 Main Process 完成。

### 2.2 Windows 优先

产品第一目标环境为 Windows。

Electron 在以下方面更加直接：

- Node.js 子进程。
- 本地文件系统。
- Git / shell 工具。
- NSIS 安装包。
- 自动更新。
- 多窗口 / 多实例桌面交互。
- macOS 后续迁移成本低。

### 2.3 产品本质更接近桌面 IDE

本产品不是普通 Web App，而是：

```text
Workspace
+ Local Filesystem
+ Agent Runtime
+ Long-running Process
+ Local Persistence
+ Markdown Editor
+ Multi-window
```

因此更接近：

- VS Code
- Cursor
- desktop coding agent

而不是传统浏览器 SaaS。

Electron 的工程模型更适合这种应用。

---

## 3. 总体架构

```text
┌──────────────────────────────────────────────┐
│                Electron App                  │
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Renderer Process                       │  │
│  │ React + TypeScript                     │  │
│  │                                        │  │
│  │ Session Launcher                       │  │
│  │ Round Sidebar                          │  │
│  │ Result Page                            │  │
│  │ Spec Editor                            │  │
│  │ Runner Overlay                         │  │
│  │ Plan / Vibe / Loop UI                  │  │
│  └──────────────────┬─────────────────────┘  │
│                     │ Electron IPC            │
│  ┌──────────────────▼─────────────────────┐  │
│  │ Main Process                           │  │
│  │ Node.js + TypeScript                   │  │
│  │                                        │  │
│  │ AppController                          │  │
│  │ SessionService                         │  │
│  │ RoundService                           │  │
│  │ LoopController                         │  │
│  │ ResultBuilder                          │  │
│  │ WorkspaceInspector                     │  │
│  │ ArtifactService                        │  │
│  │ SQLiteStore                            │  │
│  │ DshRuntime                             │  │
│  └──────────────────┬─────────────────────┘  │
│                     │                        │
│            ┌────────▼─────────┐              │
│            │ HarnessClient    │              │
│            └────────┬─────────┘              │
│                     │ stdio JSON-RPC         │
│            ┌────────▼─────────┐              │
│            │ dsh --profile sdk│              │
│            └──────────────────┘              │
└──────────────────────────────────────────────┘
```

---

## 4. 前端技术栈

### 4.1 React

使用：

```text
React
TypeScript
Vite
```

React 负责：

- 启动页。
- Workspace / Session 选择。
- Round 缩略图。
- 成果页。
- Spec 编辑器。
- Plan / Vibe / Loop 模式切换。
- Runner 悬浮窗口。
- Runner 收起到侧栏。
- Markdown 源码 / Rendered 切换。
- 空 Session 状态。
- 执行状态展示。

Vite 用于：

- Renderer 开发服务器。
- HMR。
- TypeScript 构建。
- Electron Renderer bundle。

---

## 5. Markdown 编辑器

### 5.1 CodeMirror 6

右侧 Spec 编辑器使用 CodeMirror 6。

原因：

- Markdown 支持成熟。
- 性能稳定。
- 适合长 Spec。
- 支持语法高亮。
- 可扩展快捷键。
- 后续容易支持 Diff、Selection、引用内容等功能。
- 比普通 textarea 更适合长期产品化。

V1 编辑器能力：

```text
Markdown source editing
syntax highlight
undo / redo
keyboard shortcuts
scroll persistence
source / rendered switch
```

暂不加入：

- 富文本编辑。
- Block editor。
- Notion-like schema。
- 自定义 Spec DSL。

Spec 本质仍是任意 Markdown 文档。

---

## 6. Markdown 渲染

使用：

```text
react-markdown
remark-gfm
```

负责：

- Spec Preview。
- Plan 页面。
- Result 页面。
- Vibe 对话 Markdown。
- Summary / Changes / Verification / Remaining。

V1 支持：

```text
heading
list
code
blockquote
table
task list
link
inline code
fenced code block
```

---

## 7. UI 样式方案

V1 建议：

```text
CSS Modules / plain CSS
+ design tokens
```

不强制 Tailwind。

原因：

当前 UI：

- 高度定制。
- macOS white 风格。
- 多 pane。
- 大量紧凑布局。
- Drag / collapse / overlay 较多。

直接维护设计 token 更容易：

```css
--surface
--surface-secondary
--border
--text
--muted
--accent
--radius
--shadow
--spacing
```

后续如果团队更偏好 Tailwind，可以迁移，不影响架构。

---

## 8. Backend 定义

V1 不建设：

```text
HTTP Server
REST API
GraphQL
Remote Backend
```

Electron Main Process 就是 Backend。

Renderer 不允许直接：

- spawn DSH。
- 操作 SQLite。
- 读取任意文件。
- 执行 Git。
- 操作 workspace。
- 管理 Loop。
- 管理 Session runtime。

Renderer 只通过 IPC 调用 Main。

---

## 9. Electron Main Process

Main Process 是整个产品的核心 Runtime。

建议模块：

```text
main/
  app/
  dsh/
  session/
  round/
  loop/
  result/
  workspace/
  artifacts/
  persistence/
  ipc/
```

### 9.1 AppController

负责：

- 当前应用实例。
- 当前 workspace。
- 当前 Session。
- app lifecycle。
- window lifecycle。

重要规则：

```text
1 app window = 1 active Session
```

不在单个窗口内切换多个 Session。

如果打开另一个 Session：

```text
spawn / open another app window
```

---

## 10. DshRuntime

封装官方：

```text
@deepseek-ai/dsh-sdk-client
HarnessClient
```

职责：

```text
start DSH SDK process
connect
open / resume session
send prompt
subscribe events
receive final response
shutdown
recover from process failure
```

禁止：

- 自己实现 JSON-RPC transport。
- 自己 parse DSH stdout protocol。
- 直接依赖 DSH private internal packages。
- fork DSH core。

目标是尽量保证：

```text
DSH upgrade
→ SDK compatibility update
→ minimal product-side change
```

---

## 11. SessionService

职责：

```text
create DSH session
resume DSH session
bind workspace
load product metadata
discover sessions for workspace
```

启动逻辑：

```text
App Start
↓
Select Workspace
↓
canonicalize workspace path
↓
query sessions associated with workspace
↓
choose existing session
OR
create new session
```

新 Session：

```text
workspace selected
↓
create DSH session
↓
open main workspace
↓
left side empty
↓
right side Plan selected by default
↓
user writes first Spec
```

不要求用户填写 Session 名称。

展示标题后续自动生成。

---

## 12. RoundService

产品层数据：

```text
Session
  └── Round
```

Round 不是 DSH 原生结构，而是产品 UX 结构。

模式：

```text
Plan
Vibe
Loop
```

### Plan

连续 Plan 输入：

```text
Plan submit
Plan submit
Plan submit
```

属于同一个 Round。

每次提交产生一个新版本：

```text
Plan v1
Plan v2
Plan v3
```

UI 只默认显示最新版。

底层保留完整版本历史。

### Vibe

连续 Vibe：

```text
user
agent
user
agent
user
agent
```

全部追加在同一个 Round 页面。

直到：

```text
End Round
OR
switch mode
```

结束时生成 Result Summary。

### Loop

一次提交：

```text
1 Spec
→ long-running loop
→ 1 Result
```

Loop 内部多个 DSH turns 不成为产品 Round。

---

## 13. LoopController

Loop 是我们自定义的核心能力。

流程：

```text
Root Spec
↓
execute
↓
collect evidence
↓
verify
↓
evaluate
↓
complete / continue / blocked / stop
```

状态：

```ts
type LoopStatus =
  | "active"
  | "completed"
  | "blocked"
  | "budget_exhausted"
  | "failed"
```

决策：

```ts
type LoopDecision =
  | { action: "complete"; reason: string }
  | { action: "continue"; nextPrompt: string }
  | { action: "blocked"; reason: string }
  | { action: "stop"; reason: "budget" | "failure" }
```

`replan` 不单独成为 runtime action。

本质上：

```text
replan = continue + different nextPrompt
```

---

## 14. Runner

Runner 是临时执行视图。

只在 agent 正在运行时存在。

运行前：

```text
Runner hidden
```

Submit 后：

```text
Runner appears
```

Runner 展示：

```text
thinking summary
tool calls
verification
execution status
```

不展示内部 chain-of-thought。

只展示适合用户观察的执行摘要和工具事件。

Runner 可以：

```text
expanded overlay
↓
minimize
↓
sidebar compact item
```

当侧栏折叠：

```text
runner compact item
→ icon / activity indicator
```

任务结束：

```text
Runner disappears
↓
Result / Plan / Vibe page updated
```

历史成果页面本身不包含 Runner。

---

## 15. ResultBuilder

Result Builder 不是单纯让模型自由总结。

输入：

```text
DSH final response
workspace diff
changed files
verification output
artifacts
execution status
```

输出统一：

```text
Summary
Changes
Verification
Remaining
```

其中：

### Summary

本轮最终完成什么。

### Changes

实际发生的：

```text
files
code
config
docs
artifacts
behavior
```

### Verification

只能来源于真实 evidence：

```text
tests
typecheck
lint
build
manual checks
```

不允许模型凭空写：

```text
tests passed
```

### Remaining

只有存在时才显示：

```text
unfinished work
blocker
risk
follow-up
```

空则不渲染。

---

## 16. WorkspaceInspector

负责读取真实工作区状态。

建议能力：

```text
git status
git diff
changed files
new files
deleted files
workspace root
artifact discovery
```

Result Builder 和 Loop Evaluator 共用这些 evidence。

---

## 17. SQLite

V1 本地产品数据使用 SQLite。

原始设计（已被取代）：

```text
better-sqlite3
```

最终实现使用 Electron 内置 `node:sqlite` / `DatabaseSync`。Electron 44 下 `better-sqlite3` 的原生析构崩溃已通过独立复现确认；迁移及最终验收见 `docs/v1-acceptance.md`。

数据库只保存产品自己的信息，不复制 DSH 原生 conversation history。

建议表：

```text
app_session
round
plan_revision
vibe_entry
result
artifact
runtime_state
```

### app_session

```text
id
dsh_session_id
workspace_path
permission
created_at
updated_at
```

### round

```text
id
session_id
mode
status
created_at
closed_at
order_index
```

### plan_revision

```text
id
round_id
version
spec
content
created_at
```

### vibe_entry

```text
id
round_id
role
content
created_at
```

### result

```text
round_id
summary
changes
verification
remaining
status
```

不要保存：

```text
full duplicated DSH event log
full duplicated conversation context
full duplicated model history
```

DSH 仍是 agent session/context 的事实来源。

---

## 18. IPC

Renderer ↔ Main 使用 Electron IPC。

推荐采用明确 typed contract。

示例：

```ts
session.selectWorkspace()
session.listForWorkspace()
session.create()
session.open()

round.submit()
round.end()
round.list()
round.get()

runner.subscribe()
runner.minimize()

workspace.getDiff()
workspace.getArtifacts()
```

Renderer 不接触 Main 的具体 service 实现。

建议：

```text
preload
+ contextBridge
+ strict IPC allowlist
```

不要：

```text
nodeIntegration: true
```

Renderer 必须保持 sandboxed / isolated。

---

## 19. 权限

权限为 Session 级配置。

默认：

```text
workspace-write
```

映射 DSH 原生 sandbox。

支持：

```text
read-only
workspace-write
danger-full-access
```

原则：

- Plan / Vibe / Loop 不自动改变权限。
- Loop 无权自行升级权限。
- 需要超出权限时进入 blocked。
- 不实现自己的 sandbox。

---

## 20. 多 Session

产品模型：

```text
1 Electron window
=
1 Workspace
+
1 Session
```

多 Session：

```text
Window A → Session A
Window B → Session B
Window C → Session C
```

类似 VS Code 多窗口。

优点：

- 不需要复杂全局 session scheduler UI。
- Runtime 生命周期简单。
- DSH HarnessClient 生命周期清晰。
- 崩溃隔离更自然。
- Windows 用户容易理解。
- 后续 macOS 同样自然。

---

## 21. Windows

Windows 是 V1 第一优先。

目标：

```text
Windows 11
x64
```

打包：

```text
electron-builder
NSIS
```

产物：

```text
Setup.exe
```

V1 需要重点验证：

```text
path normalization
spaces in paths
Chinese paths
Git discovery
Node child process behavior
DSH executable discovery
stdio encoding
file locking
SQLite locking
long path behavior
multi-window process lifecycle
```

尤其注意：

```text
C:\Users\...
D:\workspace\...
UNC / network path
```

V1 可以先不承诺完整支持网络盘。

---

## 22. macOS

第二目标平台。

支持：

```text
Apple Silicon arm64
Intel x64
```

后期可考虑 universal binary。

打包：

```text
DMG
```

需要：

```text
code signing
notarization
entitlements
child process permission validation
```

UI 视觉设计可以保持 macOS 风格，但 Windows 行为优先保证。

---

## 23. Node.js

Node 版本必须和 DSH 当前要求对齐。

不要单独选择旧 LTS 后长期冻结。

工程约束：

```text
Node >= DSH required runtime
```

Electron 自带 Node runtime，因此还需要确认：

```text
Electron embedded Node version
vs
DSH SDK requirements
```

如果 Electron embedded Node 不满足 DSH SDK 运行要求：

优先方案：

```text
升级 Electron
```

而不是增加新的 runtime bridge。

---

## 24. pnpm

Monorepo 推荐：

```text
pnpm
```

结构：

```text
apps/
  desktop/

packages/
  shared/
  contracts/
  ui/
```

或者 V1 更简单：

```text
src/
  main/
  preload/
  renderer/
  shared/
```

第一版建议先简单，不急于 monorepo。

---

## 25. electron-builder

负责：

```text
Windows NSIS
macOS DMG
artifact naming
icons
signing config
publish config
```

初期：

```text
Windows first
```

macOS pipeline 后加。

---

## 26. 推荐目录结构

```text
src/
├── main/
│   ├── app/
│   ├── dsh/
│   │   └── DshRuntime.ts
│   ├── session/
│   │   └── SessionService.ts
│   ├── round/
│   │   └── RoundService.ts
│   ├── loop/
│   │   ├── LoopController.ts
│   │   └── LoopEvaluator.ts
│   ├── result/
│   │   └── ResultBuilder.ts
│   ├── workspace/
│   │   └── WorkspaceInspector.ts
│   ├── persistence/
│   │   ├── Database.ts
│   │   └── migrations/
│   └── ipc/
│
├── preload/
│   └── index.ts
│
├── renderer/
│   ├── app/
│   ├── launcher/
│   ├── sidebar/
│   ├── page/
│   ├── spec/
│   ├── runner/
│   └── components/
│
└── shared/
    ├── contracts/
    ├── types/
    └── constants/
```

---

## 27. 进程关系

最终运行时：

```text
Windows / macOS

Electron Application
│
├── Renderer
│
├── Main
│   │
│   ├── SQLite
│   ├── Git / FS
│   │
│   └── HarnessClient
│        │
│        └── dsh --profile sdk
│
└── OS
```

不存在：

```text
browser
remote server
HTTP localhost service
Python backend
Rust backend
Docker requirement
```

V1 保持纯本地桌面结构。

---

## 28. V1 明确不做

```text
Tauri
Rust
remote backend
cloud sync
account system
multi-session in one window
subagents
multi-agent UI
custom sandbox
custom context system
custom DSH protocol
browser version
mobile version
```

---

## 29. 最终工程决策

### Desktop

```text
Electron
```

### Renderer

```text
React
TypeScript
Vite
CodeMirror 6
react-markdown
remark-gfm
```

### Backend

```text
Electron Main
Node.js
TypeScript
```

### Agent Runtime

```text
@deepseek-ai/dsh-sdk-client
HarnessClient
dsh --profile sdk
```

### Persistence

```text
SQLite
better-sqlite3
```

### Communication

```text
Electron IPC
preload
contextBridge
```

### Package Manager

```text
pnpm
```

### Packaging

```text
electron-builder
```

### Target Order

```text
1. Windows x64
2. macOS arm64
3. macOS x64 / universal
```

---

## 30. 一句话架构

> 一个 Electron 窗口承载一个 DSH Session；React 负责文档式工作界面，Electron Main 负责本地 Backend、SQLite、Workspace 和 Loop Runtime，HarnessClient 负责驱动 DSH。
