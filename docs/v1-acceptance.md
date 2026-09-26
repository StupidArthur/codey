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

## 一、构建与静态检查

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过（`tsc --noEmit -p tsconfig.json`，退出码 0，2026-09-26 复跑） |
| 生产构建 | `pnpm build` | 通过（main/preload/renderer 三端构建成功） |
| 产品域探针 | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/temporal-domain.mjs` | 通过（`checks` 全 **35** 项为 `true`，`passed: true`；含 `loop_wall_clock_boundary`、`loop_wall_clock_just_below_then_cross`） |
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

`temporal-domain.mjs` 的 35 项断言（全部 `true`），关键项：

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
| Loop 每次 Submit 新建一个 Round，内部 turn 不进左侧 | `loop_creates_new_terminal_round`；应用内 `loop.timelineCount=3` / `terminalRendered=true` | 通过 |
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
- Loop：`timelineCount: 3`、`terminalRendered: true`、`resultRendered: true`（Loop 新 Round + 终态 Result）。
- Round 切换：点首轮 `firstSelected: true`。

截图（`docs/evidence/ui/`，共 12 张）：`01-startup-launcher`、`01-startup-launcher-desktop`、`03-workspace-empty`、`04-plan-versions`、`05-runner-open`、`06-runner-collapsed`、`07-sidebar-collapsed`、`08-runner-restored`、`09-vibe-result`、`10-loop-result`、`11-round-1`、`12-round-last`。

截图合规性：工作区各状态为 CDP 页面级截图（2501×1469，渲染器像素，只含应用页面，不含其它窗口）；`01-startup-launcher-desktop` 为 `PrintWindow` 窗口级截图（1442×901，只绘制应用窗口）。逐张像素统计与 CDP 启动页一致（启动页 2501×1469 / 窗口级 1442×901 均为 `meanRGB=(241,244,248)`、强色像素 0%），且无一张具有用户浏览器全屏的尺寸（1646×1029），可确认不含其它应用或私人内容。

原型对照说明：Workspace 侧（模式切换、单 Session、Round 缩略图、Spec 编辑器、Result、Runner 覆盖/收起/侧栏 mini、旧历史占位）与 `requirement/dsh-final-workspace.html` 一致。启动页 hero 与 `requirement/dsh-final-startup.html` 一致；**启动页的 “Session 列表” 子状态未能目视截取**：`window.temporal.chooseWorkspace` 由 `contextBridge` 冻结、不可覆写（`pickerOverrideSupported: false`），且无 IPC 可在不打开 Session 的情况下注入 `workspacePath`，原生目录对话框也无法自动化。该子状态的功能正确性由“验收 A — 旧 Session 兼容”的发现/打开路径覆盖。

## 五、阶段 D — Evidence、Result 与 Loop

| 项 | 证据 | 结果 |
| --- | --- | --- |
| 执行前后 workspace 证据（git/非 git/产物/工具事件） | `EvidenceCollector`（非 git 用文件集时间戳差分）；`evidence_persisted` | 通过 |
| 每条 Verification 对应真实证据 | `no_evidence_no_passed_verification` / `evidence_backs_verification` | 通过 |
| 失败/预算终态显示真实原因，不输出空 Remaining | `failed_result_has_reason` | 通过 |
| Loop 预算：16 continuation | `loop_budget_exhausted`（第 17 次后 `budget_exhausted`） | 通过 |
| 连续 3 次无进展 | `loop_no_progress_budget` | 通过 |
| 同一错误最多 2 次 | `loop_same_error_retry_limit` | 通过 |
| 权限/阻塞终止 | `loop_blocked` | 通过 |
| 证据充分才 `completed` | `loop_completes_with_evidence` | 通过（确定性 fake） |
| **真实模型 Loop 终态（ARK）** | `installed-app-e2e.mjs`：Loop 段 `status=blocked`、`evidence=1`、`loopTerminal.status=blocked` 且带真实原因 | 通过（证据门控下达成合法终态；`completed` 路径由确定性探针覆盖，本轮真实模型未触发通过校验的命令） |
| **2 小时墙钟预算边界** | `temporal-domain.mjs`（可注入时钟）：`loop_wall_clock_boundary`（恰好到达 `maxElapsedMs` → `budget_exhausted`、`reason` 含 “2 hour”、仅 1 turn）；`loop_wall_clock_just_below_then_cross`（差 1ms 继续，下一 turn 越过 → 2 turns，`budget_exhausted`） | 通过（确定性覆盖边界，未真实等待 2 小时） |

## 六、阶段 E — Windows 安装包与安装后验证

| 项 | 命令/路径 | 结果 |
| --- | --- | --- |
| 打包 | `pnpm dist:win`（`electron-vite build && electron-builder --win nsis --x64`） | 通过 |
| 安装包产物 | `release/Temporal Workspace Setup 0.1.0.exe`，**205.5 MB**（源码当前构建，已重装用于本页 1–3 项） | 通过 |
| 静默安装 | `<installer> /S`，退出码 0 | 通过 |
| 安装目录 | `%LOCALAPPDATA%\Programs\Temporal Workspace\Temporal Workspace.exe`（233.1 MB） | 通过 |
| 安装后真实提交（ARK） | 启动已安装应用（CDP）→ 保存模型设置 → 新建 Session → Vibe/Loop 提交 | 通过（Vibe `completed`+证据；Loop 证据背书终态；renderer 为打包页面 `pageUrlIsPackaged: true`） |
| 安装后 read-only 阻止写入 | `installed-app-e2e.mjs` 场景 `readonly` | 通过（`workspaceFile.exists:false`、`changes:[]`、`outputMentionsDenial:true`） |
| 安装后旧 Session 恢复与重启 | `installed-app-legacy-e2e.mjs` | 通过（同一 DSH ID、Round 1/2、标记召回） |
| 安装后 UI 交互 | `installed-app-ui.mjs` | 通过（12 张截图，见阶段 C） |
| 安装后稳定性 | 连续多轮真实提交（解包目录 3 轮 + 安装目录 1 轮，每轮含 Vibe+Loop） | 通过（无原生 abort，进程存活） |
| 内置 DSH | 安装包内 `resources/app/node_modules/@deepseek-ai/dsh` 版本与 `0.1.7-rc.2` 一致，用户机器无需系统 DSH | 通过 |

## 七、未运行项与阻塞

1. **启动页 “Session 列表” 子状态的目视截图**：`window.temporal.chooseWorkspace` 被 `contextBridge` 冻结不可覆写（`pickerOverrideSupported: false`），无 IPC 可在不打开 Session 时注入 `workspacePath`，原生目录对话框不可自动化。功能正确性由验收 A 的发现/打开路径与 `dsh-session-discovery-impl.mjs` 覆盖，仅该子状态无独立截图。
2. **真实等待 2 小时的墙钟实测**：以可注入时钟在 `temporal-domain.mjs` 确定性覆盖边界（恰好到达与刚好未到），未实际挂机 2 小时。

以上未运行项不影响已通过的代码级、进程级、真实模型、安装后应用与 UI gate；不计入通过。除此之外，阶段 A–E 的可控 V1 gate 均通过。
