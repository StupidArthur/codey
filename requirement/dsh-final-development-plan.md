# Temporal Workspace — V1 开发 Plan List

> 基于《Temporal Workspace — 最终系统设计文档》执行。  
> 原则：先打通最小闭环，再做模式语义，再做 Loop 与结果可信度，最后做恢复与打磨。

---

## P0 — 冻结外部边界

- [ ] 锁定 DSH 版本与 `@deepseek-ai/dsh-sdk-client` 版本。
- [ ] 做一个最小 HarnessClient spike：`start → initialize → named/new session → prompt → notification → idle → close`。
- [ ] 验证同一 HarnessClient / runtime 下多次 prompt 可以持续复用 Session。
- [ ] 验证 resume 已有 `dsh_session_id`。
- [ ] 验证 SDK event / notification 中哪些字段足够投影 Runner。
- [ ] 验证当前 SDK 无 mid-turn cancel，并在产品 API 中禁止把 `End Round` 实现成 cancel。
- [ ] 验证 Workspace path canonicalization 行为。
- [ ] 确认 Session discovery 的正式公开实现：优先 DSH host/session listing；必要时使用公开 ACP `session/list(cwd)` adapter。
- [ ] 验证 `workspace-write` 以及其他 permission / sandbox preset 的实际映射方式。
- [ ] 验证 DSH Plan Mode 在 SDK runtime profile 中的开启 / 关闭路径。

**验收：** 所有外部 DSH 依赖都有可运行 spike，不依赖 internal import 或手工解析 JSONL。

---

## P1 — Desktop Shell

- [ ] 初始化 Electron + React + TypeScript 项目。
- [ ] 建立 main / renderer 分层。
- [ ] 加入 typed IPC contract。
- [ ] 实现 macOS 风格无业务依赖窗口骨架。
- [ ] 实现 `WindowManager`。
- [ ] 定义“一窗口一 Session”约束。
- [ ] 支持创建第二个应用窗口。
- [ ] 关闭窗口时正确 dispose 对应 runtime。
- [ ] 应用完全退出时清理所有 child processes。

**验收：** 可以打开多个独立窗口，每个窗口拥有独立 controller 生命周期。

---

## P2 — Product Domain & Persistence

- [ ] 定义 `ProductSession`。
- [ ] 定义 `RoundBase / PlanRound / VibeRound / LoopRound`。
- [ ] 定义 `ResultDocument`。
- [ ] 定义 `EvidenceBundle`。
- [ ] 定义 `LoopState / LoopDecision`。
- [ ] 定义 `RunnerEvent`。
- [ ] 定义 `Draft` + revision id。
- [ ] 建立 app-local SQLite。
- [ ] 建表：sessions。
- [ ] 建表：rounds。
- [ ] 建表：plan_versions。
- [ ] 建表：vibe_entries。
- [ ] 建表：results。
- [ ] 建表：execution_refs / evidence index。
- [ ] 建表：drafts / ui state。
- [ ] 加 migration mechanism。

**验收：** UI 产品数据可独立持久化，但不复制完整 DSH Session event log。

---

## P3 — Workspace-first Startup

- [ ] 实现系统 directory picker。
- [ ] 实现 workspace path canonicalization。
- [ ] 实现 `SessionDiscoveryAdapter`。
- [ ] 输入/选择目录后列出该目录的 DSH Sessions。
- [ ] Session 列表按最近活动排序。
- [ ] 列表始终提供 `New Session`。
- [ ] 空目录显示“没有历史 Session”，但仍可 New Session。
- [ ] Recent Workspaces 只保存目录，不直接充当全局 Session switcher。
- [ ] 点击已有 Session → 打开工作区。
- [ ] 点击 New Session → 直接打开空工作区。
- [ ] 去掉 Session name 创建表单。
- [ ] 去掉 Session ID 手动输入 UI。

**验收：** App 启动完整实现 `choose directory → existing session / new session`。

---

## P4 — DSH Runtime Adapter

- [ ] 实现 `DshRuntimeAdapter` wrapper。
- [ ] 内部只使用官方 HarnessClient / public API。
- [ ] `start()`。
- [ ] `attachSession(sessionId?)`。
- [ ] `prompt()`。
- [ ] notification subscription。
- [ ] wait / idle projection。
- [ ] typed error mapping。
- [ ] `close()`。
- [ ] runtime stderr diagnostic capture。
- [ ] lazy-create 新 DSH Session：New Session 第一次 submit 时才真正生成 session id。
- [ ] 生成后立即保存 `dsh_session_id`。

**验收：** 新 Session 与已有 Session 都可以连续执行多个 turn，并在重启后 resume。

---

## P5 — 主工作区 UI

- [ ] 左侧 Round sidebar。
- [ ] Round thumbnail component。
- [ ] 默认选中最新 Round。
- [ ] Sidebar collapse / expand。
- [ ] Sidebar 折叠时保持 Round 极简索引。
- [ ] 中间 Result viewport。
- [ ] New Session 空白状态。
- [ ] 右侧固定 Spec panel。
- [ ] `Plan / Vibe / Loop` 同行 selector。
- [ ] `源码 / MD` 同行 selector，并位于模式按钮右侧。
- [ ] Markdown source editor。
- [ ] Markdown rendered preview。
- [ ] 底部两个等宽按钮。
- [ ] 移除解释性提示行和多余 metadata card。
- [ ] 收紧 title / toolbar / panel padding，达到最终原型的信息密度。

**验收：** 与 `dsh-final-workspace.html` 的布局和密度一致。

---

## P6 — Draft System

- [ ] 每个 Session 保存独立 draft。
- [ ] draft 每次修改递增 revision id。
- [ ] submit 时记录 submitted revision。
- [ ] 执行期间 editor 保持可编辑。
- [ ] 当前执行期间 Submit disabled。
- [ ] 当前执行期间 End Round disabled。
- [ ] execution 完成时，如果 draft revision 未变化则清空已提交内容。
- [ ] 如果用户已开始写下一份 Spec，则保留新的 draft。
- [ ] Source / MD 切换不丢编辑状态。

**验收：** “运行时写下一份 Spec”不会被上一轮完成事件覆盖或清空。

---

## P7 — Runner / Observability

- [ ] 建 `RunnerProjector`。
- [ ] 从 DSH notifications 映射 `thinking`。
- [ ] 映射 tool start / finish。
- [ ] 映射 verification。
- [ ] 映射 blocked / error。
- [ ] 非运行阶段 Runner 完全不渲染。
- [ ] Submit 后浮在中间 Result viewport 上。
- [ ] Runner 不替换当前 Result page。
- [ ] 可点击“收起到侧栏”。
- [ ] 收起后在 Sidebar bottom 显示 mini runner。
- [ ] Sidebar 折叠后 mini runner 进一步变为状态点/icon。
- [ ] 点击 mini runner 恢复浮窗。
- [ ] execution terminal 后 Runner 自动消失。
- [ ] 不在主 UI 长期保存完整 console。

**验收：** 运行过程中仍可浏览所有历史 Round，并可编辑右侧下一份 Spec。

---

## P8 — Round Engine

- [ ] 实现 `RoundEngine.submit(mode, spec)`。
- [ ] 实现 `RoundEngine.endCurrent()`。
- [ ] 建立 active round pointer。
- [ ] mode switch 前 finalize 当前 Plan/Vibe。
- [ ] Loop 不保持 open round。
- [ ] Round sequence 稳定递增。
- [ ] Round terminal state 落库。
- [ ] UI mutation 与 DB transaction 保持一致。

**验收：** Round 是“连续工作阶段”，而不是每一次 prompt。

---

## P9 — Plan Mode

- [ ] 默认 New Session mode = Plan。
- [ ] 第一次 Plan submit 创建 Plan Round。
- [ ] 后续连续 Plan submit 追加 `PlanVersion`，不新建 Round。
- [ ] 每个 version 保存 submitted Spec。
- [ ] 每个 version 保存完整 plan markdown。
- [ ] 左侧缩略图只显示最新 Plan。
- [ ] Plan page 默认渲染最新版。
- [ ] 提供 version history UI。
- [ ] version 切换不改变 Round selection。
- [ ] `End Round` finalize Plan。
- [ ] 切换到 Vibe/Loop 自动 finalize Plan。
- [ ] 接入 DSH 原生 Plan Mode guidance。
- [ ] 明确 Plan sandbox policy，不把 soft guidance 当权限。

**验收：** `Plan → Plan → Plan` 只有一个 Round，但有完整 v1/v2/v3 历史。

---

## P10 — Vibe Mode

- [ ] 首次 Vibe submit 创建 Vibe Round。
- [ ] 连续 Vibe submit 不创建新 Round。
- [ ] 每次保存 `VibeEntry`：Spec + assistant output + execution outcome。
- [ ] 页面持续追加 conversation。
- [ ] Round active 时不显示虚假的最终 Result。
- [ ] `End Round` 时运行 Vibe Result Builder。
- [ ] 切换到 Plan/Loop 时自动运行 finalize。
- [ ] 最终 Result 插到 conversation 顶部。
- [ ] `Remaining` 为空则不渲染。
- [ ] finalized 后下一次 Vibe submit 新建 Vibe Round。

**验收：** 连续 Vibe 是“一页对话”，结束后成为“Result + Conversation”的最终成果页。

---

## P11 — Evidence Collector

- [ ] 记录 execution 前 workspace baseline。
- [ ] 检测是否 Git repo。
- [ ] Git repo：采集 changed files。
- [ ] Git repo：采集 diff stat / scoped evidence。
- [ ] 非 Git repo：使用 filesystem snapshot / mtime / known tool output 做最小证据。
- [ ] 从 DSH event stream 收集 test/build/lint command outcome。
- [ ] 保存 exit status。
- [ ] 收集 generated artifact path。
- [ ] 生成标准 `EvidenceBundle`。
- [ ] 对大型 diff 限流 / summarize，避免 Result Builder prompt 失控。

**验收：** Result Builder 不依赖 agent 自报“测试通过”。

---

## P12 — Result Builder

- [ ] 定义 structured output schema。
- [ ] 输入 DSH final response。
- [ ] 输入 EvidenceBundle。
- [ ] 输入 terminal status。
- [ ] 输出 `Summary`。
- [ ] 输出 `Changes`。
- [ ] 输出 `Verification`。
- [ ] 可选输出 `Remaining`。
- [ ] 做 schema validation。
- [ ] Verification 做 evidence cross-check。
- [ ] 删除 unsupported verification claim。
- [ ] 不生成空 section。
- [ ] Result 落库。
- [ ] Result renderer 完成。

**验收：** 所有 Verification 都可追到事实证据。

---

## P13 — Loop Controller

- [ ] 实现 `LoopState`。
- [ ] 实现 budget 配置。
- [ ] 实现 continuation count。
- [ ] 实现 `LoopDecision` parser / schema。
- [ ] 实现 execute → evidence → evaluate 主循环。
- [ ] `complete` 路径。
- [ ] `continue(nextPrompt)` 路径。
- [ ] `blocked` 路径。
- [ ] `budget_exhausted` 路径。
- [ ] `failed` 路径。
- [ ] no-progress detection。
- [ ] repeated-failure detection。
- [ ] evaluator prompt 固定引用 root Spec，而不是只看上一轮回复。
- [ ] replan 只作为 continuation prompt，不新增 runtime state。
- [ ] 每次内部 DSH continuation 只作为 Loop 内部 activity。
- [ ] 内部 continuation 不生成 sidebar thumbnail。
- [ ] terminal 后只生成一个 Loop Result page。

**验收：** 一个 Loop submit 即使内部执行多次，也只有一个用户级 Round。

---

## P14 — Loop Budget

- [ ] `maxContinuations`。
- [ ] `maxElapsedMs`。
- [ ] 可选 token budget。
- [ ] 可选 tool-call budget。
- [ ] budget 每轮检查。
- [ ] budget terminal reason 落库。
- [ ] Result Remaining 中反映未完成内容，而不是伪装 complete。

**验收：** Loop 不会无限持续，所有 stop 都有明确原因。

---

## P15 — Permission / Sandbox

- [ ] ProductSession 保存 permission preset。
- [ ] 默认 `workspace-write`。
- [ ] 映射到 DSH native sandbox/policy。
- [ ] runtime init 时应用。
- [ ] 不因 Loop 自动提升权限。
- [ ] permission denied 映射为 Runner event。
- [ ] 无法继续时 Loop → blocked。
- [ ] 为未来 Session settings UI 留接口。

**验收：** 所有实际文件能力由 DSH enforcement，而不是 UI 假限制。

---

## P16 — Existing Session Resume

- [ ] 通过 workspace discovery 选择 DSH Session。
- [ ] 打开对应 ProductSession record。
- [ ] 如果第一次被本产品打开但没有 ProductSession record，则创建 projection record。
- [ ] resume DSH session。
- [ ] 加载 Round list。
- [ ] 默认选择最新 Round。
- [ ] 没有产品 Round 但有 DSH history 时，显示“历史 Session / 尚无 Temporal Round”兼容状态。
- [ ] 新提交从当前产品 mode 规则继续。

**验收：** 关闭 App 后可恢复，且不重新把旧对话塞进 prompt。

---

## P17 — Crash / Recovery

- [ ] SQLite transaction boundary。
- [ ] runtime exit detection。
- [ ] window crash recovery。
- [ ] dangling active Round detection。
- [ ] 标记 interrupted / partial。
- [ ] `reconcileSession()`。
- [ ] 确认 DSH session cwd 与当前 workspace 相符。
- [ ] 确认 dsh_session_id 仍存在。
- [ ] 不自动伪造丢失 Result。
- [ ] draft autosave。

**验收：** 强杀应用后重新打开不会丢 draft，也不会把未完成 Round 标成 completed。

---

## P18 — Session Display Title

- [ ] New Session 初始显示 `New Session`。
- [ ] 第一份有效 Spec 后生成候选标题。
- [ ] 第一份结果完成后可 refine title。
- [ ] 标题仅为产品 metadata。
- [ ] 不要求用户创建时输入名称。
- [ ] 预留未来 rename。

---

## P19 — Multi-window

- [ ] `New Window` command。
- [ ] 新窗口打开 startup flow。
- [ ] 两个窗口可以同时运行不同 DSH Session。
- [ ] 两个窗口的 RuntimeAdapter 完全隔离。
- [ ] 一个窗口 crash/close 不 dispose 另一个窗口 runtime。
- [ ] macOS Window menu 正确列出窗口。

**验收：** 多 Session 的唯一主要交互就是多个独立窗口。

---

## P20 — Visual Polish

- [ ] 对齐最终白色 macOS style。
- [ ] 标题区保持紧凑。
- [ ] Round card 保持紧凑。
- [ ] Result page 不做大面积 hero header。
- [ ] 右侧 toolbar 单行。
- [ ] 底部 action bar 单行。
- [ ] 避免重复 label / explanation。
- [ ] markdown typography 优化。
- [ ] 长 Result scroll behavior。
- [ ] Runner 最大高度与 resize 行为。
- [ ] Sidebar mini runner 在折叠态仍可点击。

---

## P21 — Automated Tests

### Domain unit tests

- [ ] Plan round reuse。
- [ ] Plan version history。
- [ ] Vibe round reuse。
- [ ] Vibe finalize。
- [ ] Loop creates new round each submit。
- [ ] mode switch finalize。
- [ ] Result schema。
- [ ] evidence validation。
- [ ] Loop status transitions。
- [ ] budget exhaustion。
- [ ] draft revision race。

### DSH integration tests

- [ ] SDK initialize。
- [ ] create new session。
- [ ] resume session。
- [ ] sequential prompts。
- [ ] notification projection。
- [ ] child process close。
- [ ] transport failure。
- [ ] cwd session discovery。

### E2E

- [ ] Startup → workspace → New Session。
- [ ] Startup → workspace → existing Session。
- [ ] New Session starts with Plan selected。
- [ ] first Plan produces Round 1。
- [ ] multiple Plan revisions stay Round 1。
- [ ] Vibe conversation accumulates。
- [ ] End Vibe generates Result header。
- [ ] Loop internal continuation remains one Round。
- [ ] Runner can minimize into sidebar。
- [ ] Sidebar can collapse with runner mini preserved。
- [ ] editing next Spec while running is preserved。
- [ ] reopen App restores everything。
- [ ] two windows run independently。

---

## P22 — Packaging & Release

- [ ] DSH binary/package resolution strategy。
- [ ] compatible DSH version check。
- [ ] first-run dependency error UX。
- [ ] logs location。
- [ ] product DB location。
- [ ] macOS signing/notarization。
- [ ] auto-update strategy（可后置）。
- [ ] crash report opt-in / telemetry policy。
- [ ] upgrade migration test。

---

# 推荐实现顺序

严格按下面的纵向切片推进，不要先把所有模块“搭完”再集成。

## Slice A — 最小真实闭环

- [ ] Desktop shell
- [ ] Choose directory
- [ ] New Session
- [ ] HarnessClient
- [ ] right Spec editor
- [ ] Submit
- [ ] Runner overlay
- [ ] raw/simple final page

**目标：** 真正从 GUI 驱动一次 DSH 工作并看到成果。

## Slice B — Session 恢复

- [ ] Workspace session discovery
- [ ] Existing Session resume
- [ ] ProductStore
- [ ] Round thumbnail
- [ ] restart recovery

**目标：** “Session-first”成立。

## Slice C — Plan / Vibe

- [ ] RoundEngine
- [ ] Plan versions
- [ ] Vibe conversation
- [ ] End Round
- [ ] mode switch finalize

**目标：** 产品交互区别于普通 chat / console。

## Slice D — Evidence / Result

- [ ] EvidenceCollector
- [ ] ResultBuilder
- [ ] Verification enforcement

**目标：** 成果页可信。

## Slice E — Loop

- [ ] evaluator
- [ ] continuation
- [ ] budgets
- [ ] terminal states
- [ ] final result

**目标：** 完成长程工作核心差异化。

## Slice F — Production hardening

- [ ] crash recovery
- [ ] permissions
- [ ] multi-window
- [ ] E2E
- [ ] packaging

---

# V1 Ship Checklist

只有以下全部成立才 ship：

- [ ] 不依赖 DSH internal API。
- [ ] 不维护第二套 conversation context。
- [ ] Session 可恢复。
- [ ] Workspace-first 启动成立。
- [ ] 单窗口单 Session 成立。
- [ ] New Session 默认 Plan。
- [ ] Plan revision 正确归并。
- [ ] Vibe conversation 正确归并。
- [ ] Loop 内部 continuation 不污染顶层 timeline。
- [ ] Runner 非运行时完全隐藏。
- [ ] Runner 可收进 Sidebar。
- [ ] 运行时可编辑下一份 Spec。
- [ ] Result Verification 有事实依据。
- [ ] 默认 workspace-write。
- [ ] 没有伪 mid-turn cancel。
- [ ] 强杀恢复不产生错误 completed 状态。
- [ ] 两窗口可并行运行两个 Session。
