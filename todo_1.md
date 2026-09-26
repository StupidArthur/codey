# TODO 1 — DSH 旧 Session P0 闭环

> **Historical / completed:** 这是已完成阶段的任务记录；V1 已于 TODO 7 验收关闭。不得把本单的旧 HarnessClient 方案当作当前架构。请读 `docs/architecture-review.md` 与 `docs/v1-acceptance.md` 获取最终事实。

本任务由**一个 agent 独立、按顺序**完成。不要再委派其他 agent。先解决旧 Session 的发现与恢复，再收敛正式 Runtime 和 Windows 打包；本单不实现 Result Builder 或 Loop。

## 先读，再动代码

按以下顺序阅读，避免沿用旧设计中的过时假设：

1. `requirement/dsh-final-system-design.md`：Workspace-first、Session/Round、DSH 边界与恢复语义。
2. `docs/dsh-integration-status.md`、`docs/architecture-review.md`：当前证据、缺口和未验收项。
3. `src/shared/contracts.ts`、`src/main/WindowController.ts`、`src/main/dsh/{SessionDiscovery,DshRuntime}.ts`、`src/main/persistence/ProductStore.ts`、`src/renderer/src/main.tsx`：实际接线与数据归属。
4. `scripts/probes/dsh-runtime-p0.mjs`：已有探针及其输出规则。
5. 锁定版本 `0.1.7-rc.2` 的公开接口文档：[SDK 协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)、[SDK 客户端](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)、[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)。实现时以仓库实际安装的版本和可运行验证为准。

**更新后的 V1 决策：**旧历史读取不再阻塞 V1。旧 Session 在界面显示 `Existing DSH Session` 和 `Historical transcript unavailable`；不生成虚假 History、旧 Round 或旧对话。第一次 Codey 提交继续原 DSH Session，并创建 Codey Round 1。完成本任务时同步修正上述文档中与此决策冲突的表述。

## 阶段 1 — ACP 发现旧 Session

实现 `SessionDiscovery.listByWorkspace(canonicalPath)`，使用公开 ACP `session/list(cwd)`；优先使用已声明的 `@agentclientprotocol/sdk`，不要手写 DSH 私有协议或读取私有 JSONL。处理分页、目录 canonicalization、子进程启动/关闭与错误。把发现结果与 ProductStore 的产品记录合并：同一 DSH ID 只出现一次，首次打开旧 Session 时建立产品投影，随后仍使用原 DSH ID。`WindowController.listSessions()` 不能继续只返回 SQLite 中的记录。

界面区分新空 Session 和已有 DSH Session。已有 Session 无 Codey Round 时显示上述只读占位信息；不要通过给 `importedHistoryMarkdown` 填假文本来制造 History 页面。必要时修改共享 snapshot 类型，使这个状态有明确字段。

**阶段验收：**用两个不同 Workspace 和一个空目录验证 `session/list(cwd)` 的隔离与分页；重启应用后列表无重复；ACP 不可用时给出真实错误，且仍能新建 Session。记录命令、输出摘要和未验证之处。

## 阶段 2 — 真实模型 P0 与恢复

先运行 `scripts/probes/dsh-runtime-p0.mjs`，验证首次 prompt、同一 Session 连续 prompt、关闭运行时后跨进程 `resume-after-restart`、通知事件与 idle。再用阶段 1 发现的旧 Session ID 验证：第一次 Codey Spec 沿用原上下文，而不是把旧文本重新拼进 prompt。

测试凭证从本机环境或产品安全配置读取；不要写入仓库、日志或对话。没有凭证时可以继续完成独立的实现，但必须把本阶段标成**未通过**，不能把初始化握手当作 resume 成功。探针只输出状态、ID、事件种类和必要的脱敏断言。

**阶段验收：**能够复现“重启前给出随机标记，重启后在同一 Session 正确取回”的断言；cwd 不匹配或 Session 不存在时明确失败；完整关闭子进程。保存脱敏证据。

## 阶段 3 — 正式 Runtime 改用 HarnessClient

现有 `DshRuntime.ts` 使用 `DeepSeekHarness` 可保留为 P0 探针参照，但正式 `DshRuntime` 改为公开的 `HarnessClient`。保持现有对上层的 `start(sessionId?)`、`prompt()`、事件回调和 `close()` 契约；按 SDK 协议处理 `initialize`、`session/prompt`、通知订阅、等待 idle、最终 assistant 输出、超时/传输错误与关闭。一次窗口只绑定一个 Session，连续提交和内部 continuation 不重新创建上下文。

修正 `project()`：普通 `assistant` 事件不得映射成 `thinking`。只按已验证的事件类型投影为 assistant progress、工具、验证、状态或错误；没有真实 reasoning 事件时就不展示“思考过程”。更新共享事件类型和 Runner 文案，并用事件样本做针对性测试。

**阶段验收：**阶段 2 的首次/连续/resume 场景通过正式 Runtime 重跑；事件类型不误标；运行时出错后不遗留子进程；`pnpm.cmd typecheck` 与 `pnpm.cmd build` 通过。

## 阶段 4 — Windows 安装包验证

构建 `pnpm.cmd dist:win`，在安装后的应用中验证内置 DSH 的路径解析、Node 模式启动、一个真实提交、窗口关闭后的子进程回收，以及再次打开原 Session 的恢复。开发模式的启动成功不能替代本阶段。测试同一 Session 在两个窗口/进程中打开时的独占约束；发现不满足时修复或明确报告，不要把进程内 Map 当成跨进程锁。

**阶段验收：**提供安装包路径、测试环境、脱敏运行结果和失败日志；安装后 DSH 不依赖系统预装版本。若因签名、环境或凭证无法完成，准确标记未通过。

## 交付与停点

每阶段结束更新一份 `docs/p0-acceptance.md`，使用 `通过 / 未通过 / 未运行` 三种状态，附复现命令和脱敏证据。阶段 1 与阶段 2 是旧 Session V1 的核心 P0 gate；未通过时不要开始宣称旧 Session 兼容完成。阶段 3、4 的改动必须保留 SDK/ACP 公开边界，不借用 DSH 内部实现。

最后汇总修改文件、已通过的阶段、仍缺的外部能力与下一步。**不要启动 Result Builder 或 Loop 工作**；这两项另开后续任务单。
