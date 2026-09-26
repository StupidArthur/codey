# Temporal Workspace V1 — 验收记录

**最终状态：TODO 7 冻结门全部通过，V1 开发关闭。最新事实、源码提交与安装包指纹见第十节；前文保留为阶段历史，冲突时以第十节为准。**

日期：2026-09-26  
状态取值：**通过 / 未通过 / 未运行**。文本证据记录命令、计数、ID、事件种类与脱敏断言；不含凭证或用户原始对话。可视验收截图来自隔离的合成任务。

## 零、关键技术决定（本轮）

| 决定 | 原因 |
| --- | --- |
| 持久化从 `better-sqlite3@12.11.1` 改为内置 `node:sqlite`（`DatabaseSync`） | `better-sqlite3` 在 Electron `44.0.0` 主进程中**可确定性复现**原生 abort：`node::RemoveEnvironmentCleanupHook ... hooks.cc:142 Assertion failed: (env) != nullptr`。用同一 `better_sqlite3.node` 跑纯压测脚本在 `Statement` 析构即崩溃；改用内置 `node:sqlite` 后该崩溃彻底消失。 |
| Electron 固定为 `44.0.0` | DSH 的 `node-addon-require-builtin` 指纹表只支持 Electron `43.0.0` / `44.0.0` / `45.0.0-alpha.6`；`44.4.5`（V8 `15.2.124.28`）被拒。 |
| Evidence 记录 ID 改为每轮唯一（`randomUUID`） | 旧 `ws-<index>-<file>` 全局唯一，第二轮起在主键冲突时被 upsert 的 `WHERE round_id` 静默丢弃，导致“采集到证据但读回为 0”。 |
| Loop 结果证据跨 continuation 累积 | 旧实现只返回最后一轮证据，早期创建的文件在 Result 中丢失，出现“任务已完成但 evidence=0”。 |
| 权限审批按 Session preset 决策，不再一律放行 | `DshRuntime.onPermission` 旧实现无条件选 `allow`，使 `read-only` 被客户端审批绕过。现改为：`read-only` 仅批准 `read/search/think/fetch` 工具种类，其余走 `reject_*`（事件 `permission denied by read-only (<kind>)`）；`workspace-write` / `danger-full-access` 批准，边界交由 DSH sandbox 执行。 |
| `LoopController` 引入可注入时钟 | 构造参数新增 `now: () => number = Date.now`，可在不真实等待 2 小时的前提下确定性地验证墙钟预算边界（到达边界与刚好未到）。 |
| 窗口级截图改用 `PrintWindow` | 前台锁定 + 置顶都无法解除应用窗口被其它窗口遮挡；`scripts/probes/capture-window.ps1 -Mode 2`（`PW_RENDERFULLCONTENT`）只绘制目标窗口像素，启动页窗口级证据用它采集；工作区各状态用 CDP `Page.captureScreenshot`（渲染器像素，与其它窗口无关）。 |
| Verification 改由产品自有执行器运行真实命令 | 公开 ACP 无 terminal 块、无 `rawInput`/`rawOutput`、无退出码；`kind` 一律 `other`、`title` 只等于工具名。`VerificationExecutor` 用 `child_process` 在 workspace 下实跑检查并记录真实退出码/信号/输出尾/文件 stamps。DSH 工具 `completed` 与标题正则一律不算验证通过。 |
| `cmd /c` 参数加 `windowsVerbatimArguments` | Node spawn 默认会为含空格参数补引号，使 `cmd /c if exist "path" (…)` 内的内嵌引号被破坏而恒 exit 1（即使文件存在）；仅 `command==='cmd'` 时传 `windowsVerbatimArguments: true` 后 `if exist`/`findstr /c:` 等含引号命令恢复正常。 |
| 完成门槛改为四条件程序化判定 | `LoopEvaluator.decide`：① root Spec 每行提取 required item 且不截断；② 每项需被当前有效（stamps/时序比对）且相关（file 级 targets∩changedFiles）的真实检查以 exit 0 覆盖；③ 无 pending/unknown；④ 无已知反证（检查后文件再改、产物缺失、失败检查、未恢复的 DSH 工具失败）。reason 由实际 coverage 生成。 |
| 阻塞仅认结构化 `[BLOCKED]` 标记 | 模型正文行首出现 `[BLOCKED]` 才触发 `blocked` 终态，不再用宽泛否定词正则；续跑提示明确告知模型该标记的用途。 |
| Evidence 采集区分执行前存量改动 | `EvidenceCollector.baseline` 一次快照含 `preexisting` dirty 集合；`collect` 按 turn 增量产出 `changedFiles`/`turnChangedFiles`，执行前已存在的用户改动不计为本轮贡献。 |

## 一、构建与静态检查

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过（`tsc --noEmit -p tsconfig.json`，退出码 0，2026-09-26 复跑） |
| 生产构建 | `pnpm build` | 通过（main/preload/renderer 三端构建成功） |
| 产品域探针 | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/temporal-domain.mjs` | 通过（`checks` 全 **37** 项为 `true`，`passed: true`；含 `loop_wall_clock_boundary`、`loop_wall_clock_just_below_then_cross`、`loop_completes_with_valid_evidence`（TODO 5 后为 builtin 内容事实）、`loop_result_requirement_coverage`） |
| 门槛探针（TODO 5 重写） | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/loop-gate-impl.mjs` | 通过（**36** 项：15 项 evaluator 级反例/正例 + 9 项真实 collector/executor/controller 集成正反例 + Result 如实性，全部穿过正式路径，见第八节） |
| 权限边界探针（TODO 5 新增） | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/verify-permissions-impl.mjs` | 通过（**23** 项：read-only 拒绝写入/删除/改名/子进程、workspace-write 拒绝越界写、junction 拒绝、缺 preset fail closed、超时进程树终止、内建检查路径逃逸拒绝，见第八节） |
| 合并逻辑探针 | `node scripts/probes/dsh-session-merge.mjs` | 通过（10 项断言） |
| ACP 发现探针 | `node scripts/probes/dsh-session-discovery-impl.mjs` | 通过（隔离、分页、重复稳定、错误路径） |
| 发现持久化探针 | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/dsh-discovery-persistence.mjs` | 通过（重启不产生重复投影） |

## 二、阶段 A — 运行时与恢复

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 统一执行路径 | `DshRuntime` 使用 `dsh --profile acp`：`session/new` / `session/resume` / `session/prompt` | 通过 |
| 真实模型新建 + 跨进程恢复 | `scripts/probes/dsh-runtime-impl.mjs`（真实凭证，2026-09-25） | 通过（新 Session 建立标记；关闭后新进程 resume 同 ID 并取回标记，`passed: true`） |
| ACP 事件种类 | `scripts/probes/dsh-acp-exec.mjs` | 通过（`agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `usage_update`） |
| 普通文本不冒充 thinking | `src/main/dsh/projection.ts` 单元行为 | 通过 |
| SDK resume 缺口 | `scripts/probes/dsh-runtime-p0.mjs` + `docs/dsh-upstream-resume-report.md` | **未通过（上游缺口）**：`sdk` profile 只 create 不 resume；已改走公开 ACP，不在产品执行路径上 |
| 权限映射 | `DSH_PERMISSION_MODE` ← Session permission preset；`DshRuntime.onPermission` 按 preset 决策 | 通过 |
| **read-only 真实模型阻止写入（运行时）** | `node scripts/probes/dsh-permission-impl.mjs`（真实凭证，2026-09-26）：`read-only` → `created:false`、`denied:true`、事件 `[error,status,thinking,tool]`；`workspace-write` → `created:true`、`denied:false`；`passed:true` | 通过 |
| **read-only 真实模型阻止写入（安装后应用）** | 启动已安装应用（CDP 9222）→ `TEMPORAL_TEST_SCENARIO=readonly node scripts/probes/installed-app-e2e.mjs`：`sessionPermission:read-only`、`workspaceFile.exists:false`、`result.changes:[]`、`outputMentionsDenial:true`、`pageUrlIsPackaged:true`、`passed:true` | 通过 |
| **发现的旧 DSH Session 恢复并建立 Round 1** | `node scripts/probes/installed-app-legacy-e2e.mjs`（真实凭证，2026-09-26，见下） | 通过 |

### 验收 A — 旧 Session 兼容（真实模型 + 安装后应用）

命令（隔离式自启动安装后的应用）：

```
TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
TEMPORAL_TEST_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
TEMPORAL_TEST_API_KEY=<用户提供> node scripts/probes/installed-app-legacy-e2e.mjs
```

脱敏结果（`passed: true`）：

- seed：通过公开 ACP 持久化一个随机标记 Session，`seedDiscoverable: true`。
- phaseA：`listedCount: 1`、`legacyFound: true`、`legacyKind: legacy`、`legacyHasTemporalHistory: false`；打开后 `openedKind: legacy`、`openedKeepsDshId: true`、`openedHistoryState: legacy-unavailable`、`openedRounds: 0`；第一次提交 `round.sequence: 1`、`status: completed`、`sameDshId: true`、`recalledMarker: true`、`specDidNotContainMarker: true`（提交文本不含标记，标记来自恢复的上下文）、`timedOut: false`。
- phaseB（优雅关闭并重启应用）：`recoveredRounds: 1`、`recoveredDshId: true`；再次提交后 `roundsAfterSubmit: 2`、`sameDshIdAfterSubmit: true`、`recalledMarkerAfterRestart: true`、`timedOut: false`。

结论：不解析私有 JSONL、不倒推旧 Round；旧历史显示 `legacy-unavailable` 占位，第一次 Codey 提交在**原 DSH Session** 上建立 Round 1，重启后按原 ID 恢复并继续。

## 三、阶段 B — 产品域、持久化与窗口

`temporal-domain.mjs` 的 37 项断言（全部 `true`），关键项：

- 新 Session 默认权限 `workspace-write`，可持久化修改。
- draft revision 递增；只有 revision 未变时才清理已提交草稿。
- Round 执行开始/结束顺序正确（重复开始被拒；结束后仍为 active 但 `runtime_active=0`）。
- 崩溃中的执行被 reconcile 为 `interrupted`，绝不写成 `completed`。
- Plan 版本按序累积；evidence/result 投影可从 `listRoundDetails` 读回。
- **同进程 lease** 排斥、释放后可重取。
- **跨进程 lease**：子 Electron-Node 进程持锁时父进程获取失败；子进程正常退出后父进程可获取；子进程被强杀后父进程仍被拒（锁保留至 TTL±，证明崩溃不会误放行）。

| 项 | 结果 |
| --- | --- |
| 一窗口一 Session + 跨进程独占（进程级测试） | 通过 |
| 数据库迁移可恢复 | 通过（migration1→3 顺序执行；重启加载持久数据） |
| 运行期间编辑的下一份 Spec 重启后仍在 | 通过（draft revision 语义） |
| 悬空执行标为 `interrupted` | 通过 |

## 四、阶段 C — Plan / Vibe / Loop Runner UI

| 项 | 证据 | 结果 |
| --- | --- | --- |
| Plan 连续提交复用 Round 并累积版本 | `temporal-domain.mjs`：`plan_reuses_single_round` / `plan_two_versions`；应用内 `installed-app-ui.mjs`：`plan.timelineCount=1` / `versionTabs=2` | 通过 |
| Plan→Vibe 自动收口 | `plan_to_vibe_finalizes_plan` | 通过 |
| 连续 Vibe 累积、结束后顶部 Result | `vibe_reuses_round` / `vibe_finalize_builds_result`；应用内 `vibe.resultRendered=true` | 通过 |
| Loop 每次 Submit 新建一个 Round，内部 turn 不进左侧 | `loop_creates_new_terminal_round`；应用内 `loopA.timelineCount=3` / `loopB.timelineCount=4` | 通过 |
| **真实应用内 Vibe 提交（ARK 模型）** | `scripts/probes/installed-app-e2e.mjs`：Vibe 段 `status=completed`、`evidence=1`、`NOTES.md` 标记匹配 | 通过 |
| Runner 覆盖但不替换 Result；终态消失；可收回侧栏 | 应用内 `installed-app-ui.mjs`：`openSeen`/`miniShown`/`collapsedClass`/`miniAccessibleWhenCollapsed`/`restored` 全 `true` | 通过（真实应用内目视） |
| 旧历史只读占位 | `sessionMerge` + renderer 占位；`installed-app-legacy-e2e.mjs` `historyState: legacy-unavailable` | 通过 |
| **与应用交互对照原型（可见桌面）** | `installed-app-ui.mjs`（见下） | 通过 |

### 验收 C — 安装后应用 UI 实测（可见桌面）

命令（探针自启动安装后的应用，独立 CDP 端口与隔离 `DSH_HOME`）：

```
TEMPORAL_TEST_PROVIDER=volc-ark TEMPORAL_TEST_MODEL=deepseek-v4-flash \
TEMPORAL_TEST_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \
TEMPORAL_TEST_API_KEY=<用户提供> node scripts/probes/installed-app-ui.mjs
```

脱敏结果（`passed: true`，`uiExit=0`）：

- 真实 OS 窗口：`osWindow: "Temporal Workspace/6033010"`（标题 + `MainWindowHandle` 非 0，非 headless webview）。
- 启动页：`launcherHero: true`（含“打开一个 Workspace”）。
- 工作区骨架：`hasModeSwitch/hasEditor/hasTimeline=true`、`modeLabels: ["Plan","Vibe","Loop"]`、`permission: workspace-write`。
- Plan×2：`timelineCount: 1`、`versionTabs: 2`（`Plan → Plan` 只有一个 Round、两个版本）。
- Runner：打开 → `收起` 出现 mini → 折叠侧栏后 mini 仍可达 → 点击 mini 恢复 Runner，全部断言 `true`；`idle: true`。
- Vibe：`End Round` 后 `resultRendered: true`。
- Loop A（正向，真实可验证任务）：Spec `Create a file named ui-answer.txt whose contents are exactly the single line: ok.` + `Run: type ui-answer.txt` → `loopTerminalClass: loop-completed`、Verification 两行 `artifact req-1 ✔passed (exit 0)` / `verify req-2 ✔passed (exit 0)`、`artifactOnDisk: true`、`remainingLines: []`、终态 reason 含 `req-1`/`req-2` 覆盖（非无条件 “Spec requirements are covered”）。**Round 结束不等于成功：completed 判定以磁盘产物 + 真实退出码验证证据为准**。
- Loop B（负向，故意不可验证）：Spec 要求只回一句 “I am blocked…” → 模型显式 `[BLOCKED]` → `loopTerminalClass: loop-blocked`、`notReportedCompleted: true`、Remaining 如实显示 `The model reported that it needs user input to continue.` 与 `No verification evidence passed for this execution.`。一个 Round 结束（blocked）**没有**被渲染成任务成功。
- Round 切换：点首轮 `firstSelected: true`。

截图（`docs/evidence/ui/`，共 13 张）：`01-startup-launcher`、`01-startup-launcher-desktop`、`03-workspace-empty`、`04-plan-versions`、`05-runner-open`、`06-runner-collapsed`、`07-sidebar-collapsed`、`08-runner-restored`、`09-vibe-result`、`10-loop-a-result`、`11-loop-b-honest-failure`、`11-round-1`、`12-round-last`。

截图合规性：工作区各状态为 CDP 页面级截图（2501×1469，渲染器像素，只含应用页面，不含其它窗口）；`01-startup-launcher-desktop` 为 `PrintWindow` 窗口级截图（1442×901，只绘制应用窗口）。逐张像素统计与 CDP 启动页一致（启动页 2501×1469 / 窗口级 1442×901 均为 `meanRGB=(241,244,248)`、强色像素 0%），且无一张具有用户浏览器全屏的尺寸（1646×1029），可确认不含其它应用或私人内容。

原型对照说明：Workspace 侧（模式切换、单 Session、Round 缩略图、Spec 编辑器、Result、Runner 覆盖/收起/侧栏 mini、旧历史占位）与 `requirement/dsh-final-workspace.html` 一致。启动页 hero 与 `requirement/dsh-final-startup.html` 一致；**启动页的 “Session 列表” 子状态未能目视截取**：`window.temporal.chooseWorkspace` 由 `contextBridge` 冻结、不可覆写（`pickerOverrideSupported: false`），且无 IPC 可在不打开 Session 的情况下注入 `workspacePath`，原生目录对话框也无法自动化。该子状态的功能正确性由“验收 A — 旧 Session 兼容”的发现/打开路径覆盖。

## 五、阶段 D — Evidence、Result 与 Loop

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 执行前后 workspace 证据（git/非 git/产物/工具事件） | `EvidenceCollector`（非 git 用文件集时间戳差分）；`evidence_persisted` | 通过 |
| Verification 由产品执行器实跑并记录真实事实（TODO 5 后为 builtin/shell 事实层） | `loop_completed_evidence_is_builtin_content_fact`；安装后 e2e Loop 段 `verificationCount≥1`、`evidenceKinds` 含 `command` | 通过 |
| 工具 completed ≠ 检查通过 | `loop-gate-impl.mjs`：工具 completed 但 exit 非零 → `observed`/`failed`，不提升为 passed；标题含 test 的非验证调用不 passed | 通过 |
| 模型自报通过不 passed；缺退出码记 unknown | `loop-gate-impl.mjs`：回复 “done” 无 evidence 不 completed；无退出码检查记 `observed`/`unknown` 且不 completed | 通过 |
| 每条 Verification 对应真实证据 | `no_evidence_no_passed_verification` / `evidence_backs_verification` | 通过 |
| 四条件门槛：root Spec 全覆盖 + 无 pending/unknown + 相关检查通过 + 无已知反证 | TODO 5 重写后的 `loop-gate-impl.mjs`（36 项，全部穿正式路径）：A+B 仅 A、无关文件 fact、行为需求 unknown、typecheck 不覆盖 tests、`Run: exit 0` 只证明自身、检查后再改失效、**同大小同 mtime 内容哈希失效**、产物删除失效、**同对象复测清除/无关成功不清除**、长 Spec 末尾要求保留、标题要求保留、fence 不误解析为命令、工具失败/恢复；集成级：内容正例、**真实 npm test 行为正例**、内容错误、目录≠文件、缺第二文件、JSON 字段错误、行为 unknown、dfa 下 `Run: exit 0`、workspace-write 下 shell 拒绝、Result 如实性 | 通过 |
| 完成 reason 由实际 coverage 生成 | `loop_result_requirement_coverage`；安装后 Loop 终态 reason 含 `req-1 (…)` 证据 ID | 通过 |
| 失败/预算终态显示真实原因，不输出空 Remaining | `failed_result_has_reason` | 通过 |
| Loop 预算：16 continuation | `loop_budget_exhausted`（第 17 次后 `budget_exhausted`） | 通过 |
| 连续 3 次无进展 | `loop_no_progress_budget` | 通过 |
| 同一错误最多 2 次 | `loop_same_error_retry_limit` | 通过 |
| 结构化 `[BLOCKED]` 阻塞终止 | `loop_blocked`；应用内 `installed-app-ui.mjs` Loop B 模型显式 `[BLOCKED]` → `loop-blocked` | 通过 |
| 证据充分才 `completed` | `loop_completes_with_valid_evidence`（确定性正例穿过真实 collector+executor+engine） | 通过 |
| **真实模型 Loop 正/负（安装后应用，ARK）** | TODO 5 后的 `installed-app-e2e.mjs`（见第八节）：Loop 正例 Spec 无 `Run:` 行（builtin 内容检查完成）；负例 `loopNegative`（一个可满足 + 一个禁止满足 → 不 completed 且 Result 显示未覆盖项）；`loopVerifyWrite`（read-only 下 `Run:` 写入被验证执行器拒绝并记录 denied） | 通过（1 正 2 负 + read-only 拒绝，均如实） |
| **2 小时墙钟预算边界** | `temporal-domain.mjs`（可注入时钟）：`loop_wall_clock_boundary`（恰好到达 `maxElapsedMs` → `budget_exhausted`、`reason` 含 “2 hour”、仅 1 turn）；`loop_wall_clock_just_below_then_cross`（差 1ms 继续，下一 turn 越过 → 2 turns，`budget_exhausted`） | 通过（确定性覆盖边界，未真实等待 2 小时） |

## 五之二、阶段 3 — Windows 工具执行层调查（DLL 错误定位）

`todo_4.md` 声称 `0xC0000142`/`3221225794`（`STATUS_DLL_INIT_FAILED`）。分层复现与结论（均脱敏，未读私有 JSONL）：

| 层 | 探针/命令 | 结果 |
| --- | --- | --- |
| 系统层 `cmd` | `spawn('cmd',['/c','echo test-verify && type …'])`（`dsh-tooltrace-impl.mjs` systemShell） | 通过（`stdout=32`，exit 0） |
| 系统层 `pwsh` | `execFile('pwsh', …)`（`pwsh-repro-impl.mjs` systemPwsh） | **本机未安装 PowerShell 7**：`spawn pwsh ENOENT`；仅有 `powershell.exe`（Windows PowerShell 5.1）与 `cmd.exe` |
| DSH ACP 工具层（普通 Node 驱动） | `dsh-tooltrace-impl.mjs`：`pwsh` 标题工具多轮采样 + per-call 状态 | 间歇失败：3 次运行中 2 次出现 `write@failed`（DSH 的 `write` 工具，非 `pwsh`），随后模型重试成功（`fileCreated=true`）；ACP 仅暴露 `status=failed`，**无** terminal 块、`rawInput`/`rawOutput`、退出码或错误文本，模型正文也未含错误码（`modelMentionsDllError=false`） |
| 安装后应用驱动 DSH | `installed-app-e2e.mjs` / `installed-app-ui.mjs` | 真实提交正常完成；产品 Verification 走自身执行器（`cmd`，`windowsVerbatimArguments`），不受 DSH 工具间歇失败影响 |

结论（边界如实）：**无法从公开 ACP 抓到 `0xC0000142` 字面错误文本**——ACP 不传输工具错误文本/退出码。可确认的事实是：DSH 工具层（普通 Node 与安装包下同源）存在**间歇性工具失败**（本轮采样为 `write` 工具），系统层 `cmd` 正常、系统 `pwsh` 未安装；产品自身执行器用 `cmd`（恒可用）实跑检查，故安装后真实 Loop 的验证证据不依赖 DSH 工具成败。`0xC0000142` 的底层归属因此标为**未在工具层文本证据中确认根因**，不冒充已定位；对产品能力边界的体现是：验证始终用产品执行器 + 真实退出码，DSH 工具失败只作为 `observed`/knownIssue，绝不提升为 passed。

## 六、阶段 E — Windows 安装包与安装后验证

| 项 | 命令/路径 | 结果 |
| --- | --- | --- |
| 打包 | `pnpm dist:win`（`electron-vite build && electron-builder --win nsis --x64`） | 通过（TODO 4 源码 commit 重打） |
| 安装包产物 | `release/Temporal Workspace Setup 0.1.0.exe`（源码当前构建，已静默重装用于本页阶段 3/4 实测） | 通过 |
| 静默安装 | `<installer> /S`，`Test-Path` 确认安装目录存在 | 通过 |
| 安装目录 | `%LOCALAPPDATA%\Programs\Temporal Workspace\Temporal Workspace.exe` | 通过 |
| 安装后真实提交（ARK） | 启动已安装应用（CDP 9222）→ 保存模型设置 → 新建 Session → Vibe/Loop 提交 | 通过（Vibe `completed`+证据；**Loop `completed`**：`verificationCount=2`、`loopTerminal.status=completed`、reason 含 req-1/req-2 证据 ID、`remainingCount=0`；renderer 为打包页面 `pageUrlIsPackaged: true`） |
| 安装后 read-only 阻止写入 | `installed-app-e2e.mjs` 场景 `readonly` | 通过（`workspaceFile.exists:false`、`changes:[]`、`outputMentionsDenial:true`） |
| 安装后旧 Session 恢复与重启 | `installed-app-legacy-e2e.mjs` | 通过（同一 DSH ID、Round 1/2、标记召回） |
| 安装后 UI 交互 | `installed-app-ui.mjs` | 通过（13 张截图，见阶段 C；Loop A 正向 completed+exit 0 证据，Loop B 负向 blocked 不显示成功） |
| 安装后稳定性 | 连续多轮真实提交（本轮 Vibe+Loop+readonly+legacy 多场景） | 通过（无原生 abort，进程存活） |
| 内置 DSH | 安装包内 `resources/app/node_modules/@deepseek-ai/dsh` 版本与 `0.1.7-rc.2` 一致，用户机器无需系统 DSH | 通过 |

## 七、未运行项与阻塞

1. **启动页 “Session 列表” 子状态的目视截图**：`window.temporal.chooseWorkspace` 被 `contextBridge` 冻结不可覆写（`pickerOverrideSupported: false`），无 IPC 可在不打开 Session 时注入 `workspacePath`，原生目录对话框不可自动化。功能正确性由验收 A 的发现/打开路径与 `dsh-session-discovery-impl.mjs` 覆盖，仅该子状态无独立截图。
2. **真实等待 2 小时的墙钟实测**：以可注入时钟在 `temporal-domain.mjs` 确定性覆盖边界（恰好到达与刚好未到），未实际挂机 2 小时。
3. **`0xC0000142`/`3221225794` 的根因未在工具层文本证据中确认**：公开 ACP 不传输工具错误文本/退出码；`dsh-tooltrace-impl.mjs` 与 `pwsh-repro-impl.mjs` 能确认的是 DSH 工具层存在间歇失败（本轮采样为 `write` 工具）且系统 `pwsh` 未安装、系统 `cmd` 正常。产品验证不依赖 DSH 工具，安装后真实 Loop 通过产品执行器（`cmd`）拿到 exit 0 证据完成。该限制不影响已完成 gate，如实记录。

以上未运行项不影响已通过的代码级、进程级、真实模型、安装后应用与 UI gate；不计入通过。除此之外，阶段 A–E 的可控 V1 gate 均通过。

## 八、TODO 5 — 检查事实与需求满足分离 + 验证执行器权限边界（2026-09-26 二轮）

### 关键决定

| 决定 | 原因 |
| --- | --- |
| `CheckFact` 事实层与 requirement assessment 严格分层 | 旧 `suggestChecks` 把检查生成器自写的 `covers:[req-N]` 当作事实，`if exist`/任意首个变更文件即可“覆盖”功能需求。现在 executor 只记录事实（`file-exists`{isFile} / `content-equals`{sha1} / `field-equals` / `command-exit`），`LoopEvaluator.assessItem` 是唯一把事实映射到需求判定的地方：一条 requirement 的**全部** objective 条件都被最新有效且相关的事实匹配才算 satisfied；`covers` 字段从模型中删除（DB 仅保留兼容旧行）。 |
| `RequiredSpec` 解析为 objective 条件 | 每条解析出 `conditions: file/content/field/command/tests/typecheck/build`；`Run:/Verify:` 行 → 自身命令的 `command` 条件；内容提取支持中英模式（值去引号/去一个句尾标点）；`字段 key=value` → JSON field 条件（仅 `.json`）；创建动词才生成 file 条件（`修复 src/x.ts` 不被文件存在满足）；fenced 代码块既不作为要求也不误解析为 `Run:` 命令；标题行可解析出条件时保留为要求；无条件的散文行 → subjective `unknown`，永不猜测满足。 |
| 删除“任意首个变更文件”fallback | 无路径/行为类需求不再被无关文件存在性覆盖；`typecheck` 通过不覆盖 `tests` 条件（fact 按**命令串相等**匹配）；`Run: exit 0` 只证明自身命令。 |
| 旧失败清除规则 | 一个失败检查只能被**同 check 对象**（同 method+command+targets）的后续有效 passing 复测清除，无关成功不清除；检查对象以数组先后顺序（执行顺序）判定，不用 ISO 时间戳。 |
| 内建检查 = 路径约束只读 API | `file-exists`/`content-equals`/`field-equals` 不 spawn 进程；目标必须 resolve 在规范 workspace 内：词法逃逸（`..`、其他盘、UNC）先拒，再对最深存在前缀做 realpath 解析 junction/symlink 后复检（win32 大小写不敏感）；逃逸目标记 `denied` 而非失败读。 |
| shell 验证 fail closed | 任意命令在 Windows 无可用沙箱：仅 `danger-full-access` preset 执行；`workspace-write`/`read-only`/缺 preset → `outcome:'denied'` + 真实原因，绝不执行、绝不静默改 preset、绝不记 passed。 |
| 超时必须先 `taskkill /PID <pid> /T /F` 再兜底 kill | 反例实证：先 `child.kill()` 父进程即死，`taskkill /T` 找不到进程树，孙进程成为孤儿存活并在 ~6s 后写入 marker。修正后探针用批处理嵌套 cmd（孙进程自己负责延迟写入）验证进程树确实终止。 |
| 内容哈希（sha1，≤1MB） | 同大小同 mtime 的修改此前会漏检（changedSinceFiles 与 validity stamps 都只看 mtime/size）；现在快照、stamps、有效性判定都带哈希。 |
| DB migration4：`facts`/`denial` 列 | `round_evidence.outcome` 的 CHECK 域无法 ALTER，`denied` 存为 `observed` + `denial` 列，读回时重建为 `denied`；facts 以 JSON 持久化。 |
| 只对未覆盖条件建议检查 | 反例实证：已满足条件被重复建议并每轮 passing，会把 no-progress 计数永远清零，错误内容永远到不了 `failed` 终态（停在 budget_exhausted 且丢失 decision）。修复后仅对 `conditionSatisfied=false` 的条件建议检查，重复 passing 不再算进展。 |

### 验收（全部 2026-09-26 复跑）

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 门槛探针（阶段 A 反例+正例） | `loop-gate-impl.mjs` **36/36**：15 项 evaluator 级（A+B 仅 A、无关文件 fact、行为需求 unknown、typecheck 不覆盖 tests、`Run: exit 0` 只证明自身、修改/哈希/删除失效、同对象复测清除与无关成功不清除、40 行长 Spec 末尾保留、标题要求保留、fence 隔离、工具失败阻塞/同 title 恢复不阻塞）+ 9 项真实 controller/collector/executor 集成（内容正例 completed、**真实 `npm test` 行为正例 completed**、内容错误不 completed、同名目录不满足文件要求、同行两文件缺一、JSON 字段错误、行为需求 unknown、dfa 下 `Run: exit 0` 只证明自身、workspace-write 下 shell 拒绝+denied 记录）+ Result 如实性（observed 不显示 passed、denied 进入 Remaining、builtin passed 显示 content match/事实细节） | 通过 |
| 权限探针（阶段 B 测试表） | `verify-permissions-impl.mjs` **23/23**：read-only 下真实 Loop Spec `Run: echo overwritten > marker.txt` 被拒且 workspace 逐字节不变、builtin 内容检查正常通过；read-only 删除/改名被拒且树不变；read-only 子进程写入在 spawn 前拒绝；workspace-write 绝对路径/`..` 越界写拒绝且外部 marker 不变；junction 逃逸 shell 拒绝 + builtin 读拒绝（`escapes the workspace`）；缺 preset shell+builtin 均 fail closed；dfa 超时（1s）进程树终止、孙进程无迟到写入；`..` 目标 builtin 逃逸拒绝 | 通过 |
| 产品域回归 | `temporal-domain.mjs` 37/37（gate 用例改为无 `Run:` 内容 spec，`loop_completed_evidence_is_builtin_content_fact`；engine loop 在 workspace-write 下用 builtin 内容检查完成） | 通过 |
| 静态检查 | `tsc --noEmit` 退出码 0；`electron-vite build` 三端成功 | 通过 |
| **安装后 e2e（真实模型，打包应用）** | `installed-app-e2e.mjs` 全部 5 场景一次通过（`passed=true`）：`loop`（无 `Run:` 行，内容条件 → `loopTerminal.status=completed`、磁盘标记匹配、`contentMatchPassedEvidence=true`）；`loopNegative`（NOTES.md 内容检查通过但 sealed.md 按指令保持缺失 → 终态 `blocked` 不 completed、Remaining 2 行点名 `sealed.md does not exist`（`remainingMentionsForbiddenFile=true`）、`sealed.md exists:false`）；`loopVerifyWrite`（read-only：`Run:` 写入被验证执行器拒绝、`deniedVerificationEvidence=true`、Remaining 5 行含 denied 原因（`remainingMentionsDenied=true`）、`verify-write.md exists:false`、NOTES.md 未创建）；`vibe`/`readonly` 回归通过 | 通过 |
| **安装后 UI（真实模型，打包应用）** | `installed-app-ui.mjs` Loop A Spec 去掉 `Run:` 行 → `loop-completed`、Verification 行为 `content req-1 ✔ passed (content match, sha1 …)`、`hasContentMatchVerification=true`；Loop B 负向回归 `loop-blocked` 不显示成功 | 通过 |

### 未运行项与边界（TODO 5 新增）

1. **Windows 下任意命令无沙箱是设计决定而非遗漏**：正式 Loop Spec 的 `Run:`/`Verify:` 验证在 `workspace-write`/`read-only` 下记录 `denied` + 可操作原因且不执行；只有内建只读检查（存在性/内容/JSON 字段）在这些 preset 下可用。需求描述需可被内建检查验证，或显式以 `danger-full-access` 运行。
2. **DSH 工具失败的恢复识别仍按“同 title 后续 completed”**：公开 ACP 不传输工具输入/输出，无法更窄匹配；该局限已在文档记录。
3. `field-equals` 仅支持 `.json`（`JSON.parse`）；YAML/TOML 等格式无法自动核验 → 条件保持 unknown。

## 六、TODO 6 — Plan / Vibe / Loop 的真实语义（2026-09-26）

本单把完成判定的语义权威从"固定关键词解析"转回"模型理解 + 产品校验"：模型对任意自然语言 Markdown Spec 做语义覆盖判断；产品只校验可程序化判定的事实——证据存在与有效、引用真实性、明显矛盾、预算与状态。"完成需要证据"不再等于"用正则完整解析任意 Spec"。

### 关键技术决定（TODO 6 新增）

| 决定 | 原因 |
| --- | --- |
| 结构化模型决策 `temporal-decision` | 每轮回复以 fenced JSON 结尾：`{decision: completed\|incomplete\|blocked, reason, coverage[{item,status,evidence[]}], incomplete[], nextAction}`；解析取**最后一个**块；缺失/损坏时一次性严格重问（`decisionReAskPrompt`），再失败该轮按 incomplete 计。纯文本 `[BLOCKED]` 只在无结构化决策时作为回退候选信息。 |
| 完成门槛 = 模型判断 + 产品校验 | coverage 全 `met`（`uncertain` 永不完成）、每条引用存在、≥1 条当前有效且相关的 **PASSED 验证**引用；产品**无可运行检查**时允许引用产品快照核实过的工作区产物（wN）；无反证（检查后目标再改/产物缺失/失败未清除/未恢复工具失败/本轮零改动零验证）。模型一句 done 永远不够。 |
| 证据清单稳定编号 | `e1..eN` 按验证运行追加顺序稳定编号（跨轮不漂移）；`w1..wN` 按本轮 `changedFiles` 首次出现顺序，存在性由产品快照核实（文件已删除的产物不可再引用）。模型只能引用清单中存在的 id。 |
| 被拒完成的再引导 | 完成声明被产品拒绝时，续行提示明确告知"上一条完成声明未被接受"并要求重新声明、引用清单中的有效证据 id；验收标准不放宽。 |
| hash-first 证据有效性 | `runValid` 与采集器同语义：双方都有内容哈希时以内容为准（同内容重写不使证据失效，仅真实内容变更失效）；无哈希时回退 mtime+size 比对。`changedTurnByFile` 仍按轮次拒绝"检查之后又改"的运行。 |
| 沙盒验证脚本由产品落盘 | workspace-write 下产品写 `temporal-verify/<kind>.cmd`（内部 `call <script>`——修复批处理直接调用 npm/pnpm 这类批文件时控制权转移、`%ERRORLEVEL%` 行永不执行的问题），模型在 DSH 内运行 `cmd /c temporal-verify\<kind>.cmd`，产品内建检查读取真实 `<kind>.exit` 退出码工件（targets 同时锚定 `.log`，缺失或事后修改即失效）。read-only 无脚本方法；danger-full-access 保留直接 shell。 |
| 无进展判定 = 有意义变化 | 内容哈希级 turn delta + **全新**通过的检查对象（`method\|command\|targets` 签名，同一对象重复通过不计数）+ 未完成项收缩（产品解析 items 与模型 coverage 双向计数）。 |
| Plan = 引导路径 | 实测 DSH 0.1.7-rc.2 不暴露 session modes（`modes: null`）。Plan 通过 `PlanGuidance` 引导词实现"只计划不实现"；Plan×N = 单 Round 多版本；模式切换 finalize 计划轮；跨模式共用同一 DSH Session。 |
| blocked 终态前先跑完产品检查 | 模型 blocked 是最终决定，但产品先执行已建议的检查再落终态，使 Remaining 如实点名"什么通过了、什么缺失"；所有终态都保存 decision 与可用证据。 |
| Result 面向整轮 | `ResultBuilder` 以整轮 round 上下文构建：vibe 全部 entries、plan 全部版本、loop 单轮终态；**历史**轮次的通过检查明确标注，不再冒充本轮验证；`End Round` ≠ 任务成功。 |

### 阶段 1 — 可靠性修复

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 1.1 Session 独占与恢复顺序 | `scripts/probes/session-exclusivity.mjs` **16/16**：先取得所有权再 reconcile；第二窗口打开被拒时首窗口 Round/runtime_active/执行不变（直读 SQLite 断言）；锁丢失窗口不能重启运行时或修改受保护状态；打开失败清理新锁且不丢旧窗口有效所有权 | 通过 |
| 1.2 Git evidence 每轮 delta | `scripts/probes/git-evidence-delta.mjs` **20/20**：hash-first 内容级逐轮增量（同文件本轮追加修改不再丢失）；执行前存量改动归属保留；modified/staged/untracked/deleted 全覆盖 | 通过 |
| 1.3 墙钟预算 + 进程回收 | `verify-permissions-impl.mjs` **24/24**（两次运行稳定）；`temporal-domain.mjs`：进 turn 前检查预算、mid-turn deadline 经公开 `session/cancel` 真实中断（`TURN_DEADLINE_MESSAGE`，进程树回收失败如实记录）、deadline 后到达的"名义完成"不被接受、deadline 导致的失败归类 `budget_exhausted` 而非 failed | 通过 |

### 阶段 2 — Plan 行为

| 项 | 证据 | 结果 |
| --- | --- | --- |
| Plan 引导路径（无原生 modes） | `scripts/probes/plan-behavior.mjs` **13/13**：Plan 提交不产生实现产物（引导词生效）；Plan×N = 单 Round 版本递增；Plan→Vibe 切换 finalize 计划轮；同一 DSH Session 跨模式复用；Vibe 照常实现 | 通过 |

### 阶段 3 — 自然语言 Loop 与可用验证（确定性部分）

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 决策门控 | `scripts/probes/loop-decision-gate.mjs` **43/43**：解析（最后块生效、损坏 JSON、坏枚举、坏 evidence 类型、空 reason、非对象）；缺失块一次性重问后恢复完成；ghost/uncertain/stale/失败未清除拒绝完成；有效完成被接受且 `validRunIds` 记录；模型 blocked 终态并保存剩余项；无决策 continue 且记 known issue | 通过 |
| 无进展语义 | 同探针：重复同一检查对象的通过不算进展（no-progress 失败）；coverage 收缩算进展（直到 continuation 预算终止，绝不死于"无进展"） | 通过 |
| 沙盒验证脚本 | 同探针：workspace-write 产出 wrapper（`call npm test`）；真实运行产生 `tests.exit`；`wrapper_wrote_real_exit_code`、通过/失败两例由产品内建检查如实判定；read-only 无脚本方法；dfa 保留直接 shell | 通过 |
| 产物证据（非代码任务） | 同探针：主观任务引用 w1 可完成；有可运行检查时仅产物引用不足（必须引用通过验证）；已删除产物引用被拒 | 通过 |

### 阶段 3（续）— 真实模型端到端（`scripts/probes/loop-real-model.mjs`，19/19）

正式路径：`WindowController → RoundEngine.submitLoop → LoopController → DshRuntime（真实 DSH）→ EvidenceCollector → VerificationExecutor → ResultBuilder`。凭证走环境变量，不落盘、不打印。

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 长自然语言代码任务 | A：40 行 Markdown（标题/代码块/列表/末尾要求）要求修复 `calc.js` 的 `add` 真实 bug，不用任何解析器关键词。模型在 DSH 内执行产品落盘的 `temporal-verify\tests.cmd`；产品读取真实 `tests.exit=0`（sha1 记录）；`code_add_actually_fixed`、`code_tests_content_intact`（tests/ 未被改动）、单 Loop Round `completed`、`remaining: []` | 通过 |
| 非代码任务（文档） | B：NOTES.md 文档任务 → `completed`；模型引用 `e3（文件检查通过）, w2（工作区产物）, e4（主动重跑测试包装器）, w1`；705 字符正文落盘；更早一次失效的检查被如实标注「历史:曾通过，不再是当前有效验证」 | 通过 |
| 半成品负例（确定性脚本模型 + 真实采集/执行器） | C：模型只完成简单一半（写 FIXNOTES.md）并每轮声称完成引用 e1 → 产品检查：文件检查通过但 tests 缺失/失败 → 永不 completed；`half_done_names_the_gap`（Remaining 点名 tests 缺口）、`half_done_bug_not_fixed_by_claim`（一句 done 不会修复 bug） | 通过 |

### 阶段 4 — 整轮 Result

| 项 | 证据 | 结果 |
| --- | --- | --- |
| Result 面向整轮 | `ResultBuilder.build` 接收整轮 round 上下文：vibe 全部 entries（`vibe_finalize_builds_result`）、plan 全部版本（`plan_two_versions`）、loop 单轮终态（`loop_result_terminal`） | 通过 |
| 历史通过不再冒充当前验证 | `result_marks_historical_passes`：不在 `validRunIds` 中的通过运行标注「历史:曾通过，但其目标此后已变化」；真实模型 B 场景的 Result 中同样出现该标注 | 通过 |
| decision 随终态持久化 | `loop_result_saves_decision`（completed）与 `result_decision_persisted_on_failure`（failed 亦保存 reason/incomplete/knownIssues/validRunIds）；`contracts.ts` 新增 `LoopDecisionSummary` | 通过 |
| End Round ≠ 任务成功 | Vibe/Plan 的 End Round 构建的是如实摘要（无验证即显示「未运行产品验证」）；Loop 终态完全由 `loopTerminal` 决定 | 通过 |

### 阶段 5 — 渲染器、打包与安装后验收

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 提交后草稿恢复刷新 | `src/renderer/src/main.tsx`：submit 成功后清除 `localDraftDirty`，产品重新成为草稿事实源（产品在提交后清空/接管草稿，编辑器不再滞留旧文） | 通过（tsc + build） |
| Plan 新版本到达即跳到最新 | `RoundView` 对 `planVersions.length` 增加时 `setVersionIndex` 到最新；新版本到达前手动切换仍有效 | 通过（tsc + build） |
| 生产构建 | `pnpm exec electron-vite build`（main/preload/renderer）+ `pnpm dist:win` 退出码 0，`release\Temporal Workspace Setup 0.1.0.exe` 重新生成并静默安装（`/S`，安装后 exe 时间戳更新） | 通过 |
| **安装后 e2e（真实模型，打包应用）** | `installed-app-e2e.mjs`（CDP 驱动打包应用的渲染器，走真实产品 IPC）：`vibe` completed + NOTES.md 落盘（13 条证据）；`loop` **新语义下 completed**（loopTerminal=completed，content-match 证据在案）；`loopNegative` blocked 不 completed、Remaining 4 行点名 sealed.md、sealed.md 不存在、content-match 证据在案；`loopVerifyWrite` read-only 下 blocked、**denied 验证证据在案**、Remaining 含 denied 原因、verify-write.md 未创建；`readonly` completed（End Round）但无文件写入 | 通过（5 场景，`passed: true`） |
| **安装后 UI 实测（可见桌面）** | `installed-app-ui.mjs`（`passed: true`）：真实 OS 窗口（`Temporal Workspace/10030762`）；Plan×2 → `timelineCount: 1`、`versionTabs: 2`；Runner 打开/收起/mini 恢复全 true；Vibe End Round 渲染 Result；**Loop A（新语义）`loop-completed`**：终态文案为「模型判定完成 + 产品验证引用：e1 (content-equals)、e2 (file-exists) (cited: e1, e2)」，`remainingLines: []`、产物落盘；**Loop B `loop-blocked`**：模型如实解释回复格式指令与决策协议的冲突，Remaining 列出未覆盖项（产品解析 + 模型自述）与「无验证证据」，未渲染成成功 | 通过 |

### 未运行项与边界（TODO 6 新增）

1. **完成的语义权威是模型的 coverage 判断**：产品不（也无法）从任意自然语言中重新推导任务语义；产品校验的是引用存在、证据有效、无反证、预算与状态。内置 RequiredSpec 解析降级为展示与检查建议，不再充当完成门槛。
2. **引用与条目的语义关联由模型负责**：产品能证明"引用的证据存在且有效且通过"，不能证明"该证据在语义上恰好覆盖该条目"；当产品存在可运行检查时，要求至少引用一条通过验证作为兜底。
3. **沙盒验证依赖模型在 DSH 内执行产品写好的 wrapper**：模型不执行时检查缺失工件 → 判定失败/不通过，循环继续引导（含明确的重新引用提示）；不存在绕过模型的通道，也不把模型自报的退出码当证据。
4. **DSH 0.1.7-rc.2 能力边界不变**：无 session modes（Plan 为引导路径）、工具调用无退出码（Verification 由产品自有执行器实跑）——均为实测并沿用 TODO 5 的决定。
5. `field-equals` 仅支持 `.json`（沿用）；YAML/TOML 等格式由模型判断 + 产物证据覆盖。

## 十、TODO 7 最终关闭（2026-09-26）

**冻结门全部通过，V1 开发关闭。** 源码：[9e16d33](https://github.com/StupidArthur/codey/commit/9e16d33)，接续 `81099cf`；本节为该源码的最终验收记录。范围仅为证据输入关联、整轮 Result、有限回归与安装交付。未升级 DSH/Electron、启动其他 agent 或联系上游。

### A — 检查身份、输入版本与来源

- 沙盒检查具有独立 request id、`.cmd/.exit/.log` 路径、输入 fingerprint 和稳定 check object，并持久化身份。旧 Round/旧请求工件不能满足新请求。
- 内容和路径集合改变使旧证据失效，包括源码、测试、配置、新增与删除；检查期间再次读取 workspace，输入改变必须重跑。日志和 wrapper 不计任务成果、进展或输入变化。
- 同一对象的新有效检查替代旧运行，旧通过标历史。自然语言语义仍由模型 coverage 负责，产品校验引用、证据、反证与预算，不恢复逐行正则证明需求。
- UI 明确来源：**DSH 沙盒检查报告；产品核实结果产物及输入快照**。读取退出码文件不是独立观察子进程退出。产品直接执行的 full-access 检查保留真实 exit/signal。

`loop-decision-gate.mjs` 新增场景覆盖当前通过、源码/新增/删除/配置变化、工件排除、旧身份/异常记录拒绝、执行期间修改强制重跑、新结果恢复有效、历史展示与工件不算用户成果；最终 **67/67 true**。

### B — 实际整轮 Result

RoundEngine 传入全部相关请求、实际输出与执行状态。Vibe 摘要覆盖各次成果并按时间顺序标明后续调整；Plan 表达最终计划与修订，不能冒充实施；Loop 包含实际输出和真实终态。确定性整理不会新增模型调用、工具执行或 Round；去除内部 decision 块；异常时仍保存 Result 并明确回退到请求记录。

无验证时 Verification 明确“本轮未运行验证”；Plan/Vibe Remaining 明确需求完成情况未独立确认，执行结束不是功能验收通过。Changes/Verification/终态由产品事实生成。

`temporal-domain.mjs` 从实际 RoundEngine 收尾覆盖两个 Vibe 请求及实际输出、最终 Plan 输出、Loop 输出、未验证提示、异常回退、SQLite 重开一致性；最终 **53/53 true**。

### C — 安装版 Windows 进程启动修复

首次代码 Loop 已修源码但没有测试工件，诚实停在 blocked，未记为通过。公开 `AclSandbox` API 的系统对照确认：无控制台的 Electron Node GUI 子进程启动受限 cmd，实际退出码 **3221225794 / 0xC0000142**；附着隐藏控制台后同一命令 **exit 0**。这次有真实进程证据，超出此前模型自报错误码的证据边界。

`WindowsRuntimeHost.ts` 生成运行时私有 Node preload，通过子进程环境 `NODE_OPTIONS` 覆盖 Windows Electron runtime 及其 GUI runner 后代。初始化后恢复 ACP 管道，保持原 CLI/runner argv；普通项目 node.exe 跳过初始化。未修改 DSH 包实现、token、ACL 策略或 permission，没有自动提升权限。Koffi 3.3.1 原存在于 DSH 依赖，现声明直接依赖确保打包解析。

`windows-runtime-console.mjs` **10/10 true**：真实核实 argv、输入输出管道、控制台附着且隐藏、完整 GUI runner 链、工作区可写、工作区外写入拒绝且无文件。无需模型或凭证。

### D — 最终实跑命令

| 命令/探针 | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm.cmd typecheck` | 0 | 类型通过 |
| `pnpm.cmd build` | 0 | 三端构建通过，收尾复建 main hash 一致 |
| Electron Node：`loop-decision-gate.mjs` | 0 | 67/67 |
| Electron Node：`temporal-domain.mjs` | 0 | 53/53，含可控时钟墙钟边界 |
| Electron Node：`session-exclusivity.mjs` | 0 | 16/16 |
| Electron Node：`git-evidence-delta.mjs` | 0 | 20/20 |
| `node scripts/probes/verify-permissions-impl.mjs`（正常 Windows 权限） | 0 | 24/24，进程树回收及无延迟写入 |
| `node scripts/probes/windows-runtime-console.mjs`（正常 Windows 权限） | 0 | 10/10 |
| `pnpm.cmd dist:win` | 0 | 完整依赖打包成功；最终 preload 修订按下一行重新生成安装包 |
| `pnpm.cmd exec electron-builder --win nsis --x64 --prepackaged release/win-unpacked` | 0 | main 已刷新为最终 bundle，复用未变依赖目录 |
| 最终安装包 `/S` | 0 | 安装 main 与最终编译 main SHA256 相同 |
| `node scripts/probes/installed-app-ui.mjs` | 0 | 可见窗口、真实代码 Loop、整轮 Result、应用重启通过 |
| `node scripts/probes/installed-app-regression.mjs` | 0 | 自动启动安装版，installed-app-e2e 全部五场景 passed true |
| `node scripts/probes/installed-app-legacy-e2e.mjs` | 0 | 旧 Session 与跨进程恢复 passed true |

本地确定性/系统检查合计 **190 项 true**。PowerShell 的 Electron Node 命令形式：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& './node_modules/electron/dist/electron.exe' scripts/probes/temporal-domain.mjs
```

排障记录：受限工具环境禁止 CIM/taskkill，权限探针两项回收断言失败；正常 Windows 权限复跑 24/24 通过。受限环境打包的 pnpm SQLite 索引访问失败，正常权限构建成功。失败没有包装成通过，表中明确最终运行条件。安装版 DLL 问题按 C 节修复，最终真实代码任务通过。

### E — 最终安装版真实模型验收

Provider/model：`volc-ark / deepseek-v4-flash`，凭证经环境输入及产品配置入口保存。

| 场景 | 脱敏实测 |
| --- | --- |
| Plan × 2 | 1 Round / 2 版本，未实施 RELEASE.md；切换模式仍同一 DSH Session |
| Vibe × 2 / End Round | RELEASE.md、ROLLBACK.md 都存在，2 entries，摘要覆盖两次成果，明确未验证；应用真实重启后 Result 完全相同 |
| 默认 workspace-write 代码 Loop | calc.cjs 加法修复；tests/run.cjs 字节不变；nonce `.exit=0`，日志匹配固定成功标记；独立磁盘测试 exit 0；Loop completed，UI 来源明确，Remaining 空 |
| UI 负例 | sealed.md 外部缺失，Loop blocked，不冒充完成，Remaining 点名文件 |
| 五场景回归 | vibe、loop、loopNegative、loopVerifyWrite、readonly 全部实际运行、无超时、passed true；正例标记匹配；负例文件缺失；read-only 有拒绝记录且无磁盘写入 |
| 旧 Session | legacy / legacy-unavailable / 0 Round；首次提交原 ID 建立 Round 1，召回未包含在提交中的标记；重启恢复 Round 1，再提交 Round 2，仍原 ID 并召回标记 |

实际 OS 窗口 `Temporal Workspace/22414940`。Runner 展开、收起、mini、侧栏折叠可达、恢复及 Round 切换通过。13 张截图路径在 `docs/evidence/ui/`，本轮刷新其中 10 张。重点：`09-vibe-result.png`、`10-loop-a-result.png`、`11-loop-b-honest-failure.png`。

`verificationCount` 为展示行数，包含“未运行验证”提示时不等于通过数。沙盒工件是报告；真实测试、原测试未改及磁盘结果另有验收断言，没有伪造工件制造正例。

### F — 安装包指纹与非阻塞边界

- 安装包：`release/Temporal Workspace Setup 0.1.0.exe`，**215472289 bytes**。
- 安装包 SHA256：`9C0EEE6C87C86FD1C677ED06C45A62FA065635EA198B7C20189CBE4693D1153F`。
- 最终编译与安装 main SHA256：`D18FF9A9958A7E60A7ECD1006C091C7DA982C40FC5540F8E189809E2BA1DEC8A`，收尾重新构建仍相同。
- 原生历史无公开 transcript API，保持不可用占位，不解析私有 JSONL；resume 使用公开 ACP。
- 输入采集有界：深度 3、至多 200 文件/4000 项，≤1 MB 文件 hash，其余回退 size/mtime；排除验证工件、依赖、Git 元数据及明确构建输出。不能证明范围外输入或外部依赖没有变化。
- request id 防误用旧报告，不是不可伪造证明；agent 可写报告。语义覆盖由模型判断，产品核实可观察事实与反证，来源如实标注。
- 两小时预算以可控时钟验证，未真实挂机两小时。启动页 Session 列表没有独立原生目录选择截图，发现/打开由真实旧 Session 场景覆盖。
- 凭证值扫描 0 命中，无用户原始会话数据入库到仓库；临时诊断文件未提交。安装包依既有规则保留在 release，不入 Git。

以上是冻结 V1 的明确边界，**不新增开发门，不生成 TODO 8**。TODO 7 固定门全部通过；代码与本记录交付后关闭 V1 开发，后续新功能或优化由用户另行立项。
