# TODO 3 — 完成 Temporal Workspace V1

本单交给**同一个 agent 从头做到尾**。不要委派其他 agent，不要完成一个阶段就停下来等下一张任务单。按依赖顺序持续实现、验证、修复、复测，直到下面的 V1 验收全部通过。用户已经授权本项目开发；常规架构取舍自行决定并记录。只有确实缺少外部凭证、系统能力或上游接口，且已穷尽公开可行路径时，才把对应项明确标为阻塞；继续完成所有不依赖该项的工作。**不能把未运行或失败写成通过，也不能把部分功能称为 V1 完成。**

## 先读与边界

按顺序读：

1. `requirement/dsh-final-system-design.md`：冻结的 V1 产品语义，特别是最后的“已冻结的产品决策”。
2. `requirement/dsh-final-tech-stack-architecture.md`、`requirement/dsh-final-development-plan.md`：分层、P0–P22、V1 ship checklist。若早期文字与最终系统设计或本单冲突，以后者为准。
3. `requirement/dsh-final-startup.html`、`requirement/dsh-final-workspace.html`：启动页和工作区视觉与交互基准。
4. `docs/architecture-review.md`、`docs/dsh-integration-status.md`、`docs/p0-acceptance.md`、`docs/dsh-upstream-resume-report.md`：已通过的证据、未通过的 gate 和 SDK resume 缺口。
5. `src/shared/contracts.ts`、`src/main/index.ts`、`src/main/WindowController.ts`、`src/main/dsh/`、`src/main/persistence/`、`src/main/settings/`、`src/preload/index.ts`、`src/renderer/src/`、`electron-builder.yml`、`package.json` 与现有 probes：从实际代码出发，不把文档中的待办误认为已实现。

固定边界：Windows x64 优先；安装包内置版本匹配的 DSH；模型与凭证在产品内配置，凭证不进 SQLite、日志、Git；一窗口只绑定一个 Session，同一 DSH Session 在两个窗口或两个应用进程中必须独占；DSH 是对话与上下文事实来源，产品 SQLite 只保存 Temporal 投影。旧 DSH 历史按 V1 决策显示 `Existing DSH Session` / `Historical transcript unavailable`，不解析私有 JSONL、不倒推旧 Round；第一次 Codey 提交在**原 DSH Session**上建立 Round 1。只使用公开 SDK/ACP 接口。不要向 DSH 上游提交 issue 或联系维护者。

## 阶段 A — 先消除恢复阻塞，再完成运行时

1. 用真实模型和隔离的 DSH home 做端到端 spike：新 Session、连续 prompt、关闭运行时后恢复、ACP 创建后恢复、SDK 创建后经 ACP 恢复、cwd 不匹配、不存在的 ID、事件与 idle、错误和关闭。沿用现有脱敏 probe；增加必要的针对性 probe，不输出原始对话或凭证。
2. 已知 `DeepSeekHarness` / `sdk` profile 对持久 ID 只会走 `create`，不要继续把这条路径当作 resume。先检验 **HarnessClient 驱动新 Session + 公开 ACP `session/resume` 驱动持久 Session** 是否能保持同一上下文。如果跨 profile 不等价，改为由公开 ACP 驱动新建和恢复的统一执行路径；不要用私有 API、篡改 node_modules 或等待上游修复来替代可用的公开路径。把最终选择、证据和与原 HarnessClient 设计的差异写进 `docs/architecture-review.md`。
3. 把正式 `DshRuntime` 收敛为可测试的运行时接口，封装实际选用的公开传输，正确处理生命周期、连续 turn、session ID 持久化、通知、idle、超时、stderr、错误、关闭和进程回收。新 Session 第一次提交才生成 DSH ID，创建成功后立即持久化；失败不能留下可被误认作有效的 Round。普通 assistant progress/status 不能标为 `thinking`；只在确有 reasoning 事件时展示 thinking。
4. 产品内模型/凭证配置要在开发模式和 Windows 安装包中可用，设置失败要给出可操作错误；不得在 renderer、IPC snapshot、日志或 Result 中回传明文凭证。默认权限 `workspace-write` 必须由 DSH 实际执行机制约束，Plan guidance 不能冒充 sandbox，Loop 不自动提升权限。

**验收 A：** 真实模型下，新 Session 与发现的旧 Session 都能连续执行；完全退出应用或运行时再打开后，原 ID 能取回先前随机标记，且第一次 Codey 提交没有重放旧文本；cwd/ID 错误清楚；通知、idle、关闭有脱敏证据。未通过前不宣称旧 Session 兼容完成。

## 阶段 B — 产品域、持久化与窗口

1. 从臃肿的 `WindowController` 中分出 Session 管理、RoundEngine、运行时、证据和 Result 的职责。主进程负责文件系统、DSH、SQLite 与权限；renderer 只用窄且类型化的 IPC，每个请求校验发起窗口与所属 Session。
2. 完成 SQLite schema/migration 和事务边界：ProductSession、DSH ID、Round、PlanVersion、VibeEntry、Loop 状态与内部活动、Evidence、Result、draft revision、UI selection。升级现有数据库可恢复；不复制 DSH 全量 event log。新 Session、已发现旧 Session 和产品记录合并时 ID 稳定且无重复。
3. 落实一窗口一 Session 与**跨应用进程**独占。获得锁后才能打开；冲突时明确提示；正常关闭、窗口崩溃、进程异常退出后的锁恢复必须验证。不同 Session 可在不同窗口并行，关闭一个窗口不影响另一个。
4. Draft 每次修改有 revision；运行期间右侧仍可编辑下一份 Spec，但当前执行的 Submit / End Round 禁用。执行结束只清理已提交且 revision 未变的 draft。强杀/重启后 draft、Round、Result 和最近 Workspace 可恢复；悬空执行标记为 `interrupted`，不能伪造 `completed`。

**验收 B：** 新建/发现/重启/多窗口与跨进程锁通过实际应用或进程级测试；运行期间编辑的下一份 Spec 重启后仍在；数据库迁移和崩溃恢复有针对性验证。

## 阶段 C — Plan、Vibe、Runner 与工作区 UI

1. 按最终设计实现 workspace-first 启动、Session 列表、New Session、单 Session 工作区、Round 缩略图、右侧 CodeMirror Spec、Source/MD、模式切换、Result 视图和旧历史占位。对照两个 HTML 原型检查布局与状态；空目录和 discovery 失败也应能 New Session。
2. Plan 连续提交复用一个 Round，每次保存 Spec 与完整 plan 的版本；版本可浏览，End Round 或切换模式时 finalize。接入 DSH 原生 Plan guidance，并验证其与实际权限策略的边界。
3. Vibe 连续提交复用一个 Round，按顺序保存 Spec、assistant 输出与执行结果；active 时不伪造最终 Result；End Round 或切模式后生成顶部 Result。Loop 每次 Submit 新建一个 Round，内部 turn 不成为左侧 Round。
4. Runner 从真实事件投影 assistant progress、工具、验证、状态和错误；没有真实 reasoning 就不叫 thinking。运行时覆盖当前 Result 但不替换它；可收进侧栏，折叠侧栏后仍可恢复；终态消失。运行中可浏览旧 Round 和编辑 draft。

**验收 C：** `Plan → Plan → Plan` 只有一个 Round 三个版本；`Plan → Vibe` 自动收口；连续 Vibe 一页累积、结束后顶部 Result；Runner 状态与实际执行一致。用应用交互验证，不以 typecheck 代替 UI 验收。

## 阶段 D — Evidence、Result 与 Loop

1. 在执行前后采集与任务匹配的 workspace 证据：Git 变更/差异、非 Git 目录变化、文件产物、工具命令与退出码、相关测试/编译/build/lint/行为检查。限制大 diff 体积。用户指定的验证优先，其次按相关 tests → typecheck/compile → build → 项目要求的 lint → 必要行为检查；只运行项目存在且与修改相关的检查。
2. Result Builder 生成并持久化 `Summary / Changes / Verification / Remaining?`，每条 Verification 必须对应实际证据；没有证据就不能写“已通过”。失败、阻塞、预算耗尽和中断要明确显示真实停止原因；不输出空的 Remaining。
3. Loop 实现 `execute → collect evidence → evaluate → continue/terminal`。固定默认预算：最多 **16** 次内部 continuation、**2 小时**墙钟、连续 **3** 次无进展、同一错误最多 **2** 次重试；V1 主界面无需预算控件。每轮持久化状态、进展、错误签名和剩余预算；崩溃恢复不能重复执行已完成的 turn。
4. `completed` 必须同时满足：Spec 明确要求已完成、无已知 required item 未完成、有匹配任务的 Verification evidence、workspace 无已知推翻结论的问题。模型自称完成只可作为候选信号。证据不足则继续；达到预算为 `budget_exhausted`；外部条件缺失为 `blocked`；执行错误为 `failed`。所有终态只生成一个 Loop Result，不得包装成“基本完成”。

**验收 D：** 用真实工作区场景验证成功、无证据、无进展、重复错误、超时/次数预算、权限阻塞、执行失败和强杀恢复；每种状态的 Result 都显示真实原因。用针对性自动测试覆盖状态机、evidence cross-check 与 draft/事务不变量。

## 阶段 E — Windows 安装包与最终验收

1. 运行 `pnpm.cmd typecheck`、`pnpm.cmd build`、必要的针对性测试和 `pnpm.cmd dist:win`。在**实际安装后的 Windows 应用**中验证内置 DSH/SDK 的路径、Electron Node 模式、模型设置、真实提交、ACP discovery/resume、子进程退出、重启恢复、两窗口与两应用进程的独占冲突。开发模式成功不能替代安装包验证；不依赖系统预装 DSH。
2. 对照 `requirement/dsh-final-development-plan.md` 的 V1 Ship Checklist 和 `requirement/dsh-final-system-design.md` 的完成定义逐项验收；修正文档中过时的 gate 与“SDK 只能等待上游”的说法。保留 `docs/dsh-upstream-resume-report.md` 作为 SDK 缺口事实报告，不因产品采用 ACP 路径就改写真实复现结论。
3. 新建 `docs/v1-acceptance.md` 记录每项 **通过 / 未通过 / 未运行**、命令、脱敏证据、安装包路径与剩余问题。对必要验证失败的项目继续修复并重跑，直到所有可控 V1 gate 通过。完成后提交代码和文档并推送 `origin/main`；不要自动创建 release、发布安装包或提交上游 issue。

**最终交付：** 简要汇报架构取舍、变更文件、通过的 gate、实跑命令与结果、Windows 安装包验证、仍需外部输入的事项及对应证据。若凭证或外部能力实在不可得，完成其余工作并准确标注未通过/未运行，绝不以“完成”掩盖缺口。
