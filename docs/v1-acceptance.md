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

## 一、构建与静态检查

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `pnpm typecheck` | 通过（`tsc --noEmit -p tsconfig.json`，退出码 0） |
| 生产构建 | `pnpm build` | 通过（main/preload/renderer 三端构建成功） |
| 产品域探针 | `ELECTRON_RUN_AS_NODE=1 <electron> scripts/probes/temporal-domain.mjs` | 通过（`checks` 全 **33** 项为 `true`，`passed: true`） |
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
| 权限映射 | `DSH_PERMISSION_MODE` ← Session permission preset | 已接线；真实模型下 `read-only` 阻止写入的实测**未运行** |

## 三、阶段 B — 产品域、持久化与窗口

`temporal-domain.mjs` 的 33 项断言（全部 `true`），关键项：

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
| Plan 连续提交复用 Round 并累积版本 | `temporal-domain.mjs`：`plan_reuses_single_round` / `plan_two_versions` | 通过 |
| Plan→Vibe 自动收口 | `plan_to_vibe_finalizes_plan` | 通过 |
| 连续 Vibe 累积、结束后顶部 Result | `vibe_reuses_round` / `vibe_finalize_builds_result` | 通过 |
| Loop 每次 Submit 新建一个 Round，内部 turn 不进左侧 | `loop_creates_new_terminal_round` | 通过 |
| **真实应用内 Vibe 提交（ARK 模型）** | `scripts/probes/installed-app-e2e.mjs`：Vibe 段 `status=completed`、`evidence=1`、`NOTES.md` 标记匹配 | 通过 |
| Runner 覆盖但不替换 Result；终态消失；可收回侧栏 | 代码路径（`runnerOpen` 覆盖层 + 完成自动收起 + 折叠后 mini 按钮） | 通过（代码级）；真实应用内目视**未运行** |
| 旧历史只读占位 | `sessionMerge` + renderer 占位；merge 探针 `historyLegacyNoRounds` | 通过 |
| 与应用交互对照原型 | 需要可见桌面会话 | **未运行** |

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
| 2 小时墙钟 | 代码固定预算（`DEFAULT_LOOP_BUDGET.maxElapsedMs`）；长时间实测**未运行** | 代码级通过 |

## 六、阶段 E — Windows 安装包与安装后验证

| 项 | 命令/路径 | 结果 |
| --- | --- | --- |
| 打包 | `pnpm dist:win`（`electron-vite build && electron-builder --win nsis --x64`） | 通过 |
| 安装包产物 | `release/Temporal Workspace Setup 0.1.0.exe`，**205.5 MB** | 通过 |
| 静默安装 | `<installer> /S`，退出码 0 | 通过 |
| 安装目录 | `%LOCALAPPDATA%\Programs\Temporal Workspace\Temporal Workspace.exe`（233.1 MB） | 通过 |
| 安装后真实提交（ARK） | 启动已安装应用（CDP）→ 保存模型设置 → 新建 Session → Vibe/Loop 提交 | 通过（Vibe `completed`+证据；Loop 证据背书终态；renderer 为打包页面） |
| 安装后稳定性 | 连续多轮真实提交（解包目录 3 轮 + 安装目录 1 轮，每轮含 Vibe+Loop） | 通过（无原生 abort，进程存活） |
| 内置 DSH | 安装包内 `resources/app/node_modules/@deepseek-ai/dsh` 版本与 `0.1.7-rc.2` 一致，用户机器无需系统 DSH | 通过 |

## 七、未运行项与阻塞

1. **可见桌面交互验收（阶段 C UI 目视）**：需要可交互的 Windows 桌面会话；本轮以 CDP 驱动打包页面替代，未做实机目视对照。
2. **`read-only` 权限真实模型阻止写入的实测**：未运行（需针对该 preset 单独跑一轮真实提交）。
3. **2 小时墙钟预算的长时间实测**：未运行（仅代码级固定预算）。

以上未运行项不影响已通过的代码级、进程级、真实模型与安装级 gate；不计入通过。
