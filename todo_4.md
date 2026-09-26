# TODO 4 — 修正 Loop 完成判定与 Windows 工具执行验收

## 目标与执行方式

由**一个 agent 独立、连续执行**本单，不委派其他 agent，不在阶段之间等待确认。只在实际缺少外部能力时记录阻塞，并继续完成独立工作。本单完成前不得宣称 V1 已通过最终验收。修复、测试、重新打包、安装后复测、文档和提交必须形成闭环。

基线为 `1605551`。先检查当前 HEAD 和工作区，保留已有改动；不要重做已通过的旧 Session、read-only、数据库和时钟改造。

## 先读

1. `todo_3.md`、`requirement/dsh-final-system-design.md` 中 Loop completion、Verification、Result 和 Round 语义。
2. `docs/v1-acceptance.md`、`docs/architecture-review.md`。
3. `src/main/loop/LoopController.ts`、`src/main/evidence/EvidenceCollector.ts`、`src/main/result/ResultBuilder.ts`。
4. `src/main/dsh/DshRuntime.ts`、`src/main/dsh/projection.ts`、实际 RoundEngine 与 ProductStore、`src/shared/contracts.ts`。
5. `scripts/probes/temporal-domain.mjs`、`scripts/probes/installed-app-e2e.mjs`、`scripts/probes/installed-app-ui.mjs`、`docs/evidence/ui/`。

## 已确认的问题

- `LoopController.complete(text, evidence)` 只要求有一个 passed、没有 failed、回复没有命中少数否定词。它不接收 Spec/required items，不检查验证相关性，也不检查 workspace 的反证，却返回“Spec requirements are covered”。这不满足冻结的四条件。
- `TurnProjector` 用工具标题正则和 ACP `tool_call_update.status=completed` 判成 verification；`EvidenceCollector` 再把该 Runner 消息判成 passed。**工具调用完成不能直接等同于检查通过**；标题包含 test/build 也不能证明运行了相关验证。
- `07-sidebar-collapsed.png` 等截图中，模型明确报告 PowerShell DLL 初始化错误 `0xC0000142` / `3221225794`。需要核实工具层事实，而非仅引用模型文本。现有 UI probe 的 DOM 断言只能说明控件存在，不能证明 shell 正常或任务完成。

## 阶段 1 — 先建真实、可追溯的验证证据

### 怎么做

1. 查阅实际安装版本的公开 ACP 类型与 DSH 公开文档/源码，确认工具调用的 ID、kind、标题、输入、结果、退出状态如何传输。用小型真实探针采样并脱敏；不要假定字段存在，不读取私有 JSONL。
2. 将用于主界面展示的 Runner 文本与用于判定的 Evidence 分开。按 toolCallId 聚合 start/update/terminal 信息，保留结构化命令结果和来源。Runner 的限长消息、标题和 `status=completed` 不得充当退出码。
3. 对可证明的命令记录：evidence ID、turn ID、toolCallId、workspace、实际命令/验证类型、终止状态、可得的退出码、验证对象和时序。模型说“测试通过”不能写入 passed。缺少退出码或可解释的检查结果时记 observed/unknown，不提升为 passed；如公开 ACP 无足够字段，使用明确的 workspace 验证执行器补充实际检查结果。
4. Git evidence 要区分执行前已存在的用户改动与本轮改动；不要把整个 dirty workspace 当成本轮贡献。跨 turn 累积证据保留来源与有效性：检查后相关文件被继续修改时，旧通过结果不能无条件证明当前状态。
5. Result Verification 与 Loop 使用同一份事实证据；unknown 不得展示成 passed。Result 保存到数据库后可按 ID 追溯来源。

### 验收 1

增加针对性测试，证明：工具 completed 但 exit 非零不 passed；标题含 test 的非验证调用不 passed；缺少可靠结果不 passed；模型自报通过不 passed；真实相关检查退出码 0 可形成 passed；上一 turn 的通过结果在相关文件再修改后失效。记录实际公开协议可获得/不可获得的字段。

## 阶段 2 — 实现四条件完成门槛

### 怎么做

1. 用完整且固定的 root Spec 建立 required-item 清单。每项有稳定 ID、原文引用、验收方式、状态（pending/satisfied/unknown）及 evidence 引用。不得截断 Spec 后丢掉末尾要求；任意 Markdown 解析不清时保持 unknown，不能默认为已满足。
2. 增加独立的 Loop evaluator 与结构化、运行时校验的 decision。建议契约至少包含：`decision`、`reason`、逐项 coverage/evidence IDs、未完成事项、已知 workspace 问题、下一步 prompt。允许模型辅助拆分语义/提出判断，但最终 completed 必须通过程序的 evidence 校验；模型的判断本身不是 Verification。
3. 完成门槛必须同时校验：
   - root Spec 明确要求都由有效证据覆盖；
   - 没有 required item 为 pending/unknown；
   - 与任务匹配且项目实际存在的必要验证通过；
   - 当前 workspace 没有已知会推翻结论的问题，包括工具失败、必要检查失败、产物缺失/不符、检查后再次改动。
4. 将“有任意一次通过”换成“本任务的必要验证都适用且有效”。例如仅 typecheck 通过不能证明要求的新功能或要求的测试已实现。非代码任务可以用实际文件内容、产物、行为等适配的证据，不能强制所有任务都要 shell tests。
5. 证据不足继续执行，达到预算为 budget_exhausted；真实外部依赖缺失为 blocked；不可恢复错误为 failed。模型正文中出现 blocked 字样不应仅凭宽泛正则触发阻塞，引用、否定和普通描述需有结构化判断。保持原预算、单 Round、终态 Result 与崩溃恢复约束。
6. completed 的 reason 必须由实际 coverage 形成；不能无条件写“Spec requirements are covered”。Remaining 保存真正未完成项，终态与数据库、页面一致。

### 验收 2：以下反例必须全部不能 completed

| 场景 | 必须验证的结果 |
| --- | --- |
| Spec 要求 A+B，仅 A 完成，相关测试通过 | B 仍 pending；继续或真实非完成终态 |
| Spec 要求功能，但只运行无关测试且通过 | 无相关 evidence，不能完成 |
| 回复“done”，无 evidence | 不能完成 |
| required item 状态 unknown 或引用不存在的 evidence ID | decision 校验拒绝 completed |
| 验证先通过，随后相关文件被修改或产物删除 | 旧验证失效，不能完成 |
| 有通过也有未解决的必要检查失败 | 不能完成 |
| 未完成要求位于长 Spec 末尾 | 仍能识别，不能完成 |
| 回复用中文说尚未完成，或英文换一种说法 | 不依赖现有否定词正则放行 |

另须证明正向路径：所有 required items 都有当前有效、相关的证据且无已知反证，才 completed。测试必须穿过正式 evaluator/collector/controller，不能用手工 fabricated passed 绕过实际完成门槛。保留并复跑次数、无进展、重复错误和可控时钟测试。

## 阶段 3 — 排查安装后 PowerShell 错误

### 怎么做

1. 用隔离 workspace 和明确、可验证的任务复现，不再使用“Implement the first change”这种没有任务对象的 Spec。分别测试：系统直接执行 PowerShell；公开 DSH ACP 执行；安装后应用驱动 DSH 执行。记录实际进程/工具结果与退出码，判断错误出现在哪层。
2. 检查 shell 路径、参数、cwd、环境变量、权限 preset、Electron Node 模式、子进程生命周期和 DSH sandbox。不要以提权、关闭 sandbox、默认 danger-full-access 或删除用户环境配置绕过错误。
3. 若是本产品启动/环境传递问题则修复；若是 DSH 或运行环境限制，给出隔离最小复现与替代公开路径的实跑结果，并明确产品能力受限的边界。没有工具层证据时，只能写“模型报告该错误，尚未确认根因”。
4. 修正 UI probe：检查真实执行 outcome、所要求产物、验证结果和 Result 内容，不仅检查 `.result-block` 是否存在。Round 已结束与任务已成功是两个不同字段/文案，不能让用户把失败或阻塞理解成任务完成。

### 验收 3

安装后的应用在 `workspace-write` 下，通过真实 shell 完成一项简单文件修改并运行相关检查，保存退出码/内容断言等 evidence；Result 如实展示成功或失败。若 DLL 错误仍可复现，报告必须标为未通过并附脱敏复现，不得用 UI probe passed 掩盖。更新截图，截图对应明确任务且不含凭证或私人内容。

## 阶段 4 — 安装后实测与交付

1. 实跑 `pnpm.cmd typecheck`、`pnpm.cmd build`、新增针对性测试、`temporal-domain.mjs` 与必要的回归探针。
2. 重新 `pnpm.cmd dist:win` 并安装当前构建。真实模型至少跑两个明确 Loop 场景：一个完整任务可经相关验证得到 completed；一个故意保留 required item，即使有通过检查也不得 completed。记录 Spec 的脱敏验收描述、coverage、证据 ID、实际终态和 Result；不要硬编码模型输出来冒充正向实测。
3. 更新 `docs/v1-acceptance.md`、`docs/architecture-review.md`。旧证据可保留但注明对应 commit；新构建证据写明源码 commit、包路径、实跑命令与通过/未通过/未运行。把本单每阶段验收列成 checklist，不因确定性 fake 通过就声称真实完整路径已通过。
4. 修改和文档提交并推送 `origin/main`。不发 release，不提交上游 issue。最终汇报：根因、修复方式、反例与正例结果、安装后 shell/Loop 实测、未解决限制、commit。

**签收标准：** 验收 1/2/3 的必需项及安装后 Loop 正反场景都有可复核证据；原有有效 gate 无回归；所有未完成 required item 或无效 evidence 均无法触发 completed。真正外部阻塞可如实交付，但此时不能宣称 V1 完成。
