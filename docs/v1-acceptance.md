# Temporal Workspace V1 — 验收记录

日期：2026-09-26  
状态取值：**通过 / 未通过 / 未运行**。证据只记录命令、计数、ID、事件种类与脱敏断言；不含凭证或对话正文。

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
