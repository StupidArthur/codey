# TODO 6 — 回到产品目标，完成 Plan / Vibe / Loop 的真实语义

## 目标与优先级

本单交给**同一个 agent 连续完成**，不要委派其他 agent。基线 `e7fd850`，开始前核对实际 HEAD、工作区和已有改动。保留已成立的桌面、ACP Session、SQLite、草稿、版本与对话投影，不推倒重建。

我们最初要的是：**用户提交任意自然语言 Markdown Spec，DSH 理解并执行；产品组织 Plan/Vibe/Loop，观察过程、控制连续执行、保存可信成果。**“完成需要证据”不等于“用正则完整解析并证明任意 Spec”。本单纠正此前任务单造成的方向偏差：不要继续扩大固定关键词解析器来替代模型理解。

按顺序完成：可靠性修复 → Plan 行为 → 自然语言 Loop 与可用验证 → Round Result → UI 与安装后验收。阶段之间无需等待确认；遇到外部接口限制，继续完成独立项并准确报告。实现与必需验收未完成前不要宣称 V1 complete。不要发布 release、联系上游或改动用户其他项目。

## 先看代码，确认调用链

必读实际代码：

- `src/main/WindowController.ts`、`src/main/index.ts`、`src/preload/index.ts`。
- `src/main/rounds/RoundEngine.ts`、`src/main/persistence/ProductStore.ts`。
- `src/main/dsh/{DshRuntime,projection,SessionDiscovery,sessionMerge}.ts`。
- `src/main/loop/{LoopController,LoopEvaluator,RequiredSpec}.ts`。
- `src/main/evidence/{EvidenceCollector,VerificationExecutor,evidence}.ts`、`src/main/result/ResultBuilder.ts`。
- `src/shared/contracts.ts`、`src/renderer/src/{main.tsx,styles.css}`。
- 已有 domain、gate、permission、安装后 e2e/UI 探针，以及 Windows 打包配置。

需求依据仍是冻结的产品决定，但不能把验收文档中的“通过”当作实现证据。开工前建立本单验收清单，并为每条明确正式调用路径。

## 阶段 1 — 先修复已实测的可靠性缺陷

### 1.1 Session 独占与恢复顺序

现状：`openSession()` 先 `reconcileInterruptedRounds()`，再 acquire lease。第二窗口打开被拒时，首窗口正在执行的 Round 已被改成 interrupted。

要求：先证明自己取得 Session 所有权，再恢复该 Session 的悬空执行；锁冲突不能写入对方 Session 状态。检查 lease 丢失后的提交、保存与关闭行为：失去所有权的窗口不得重新启动运行时或继续修改受保护状态。切换/打开失败时清理新锁，不能丢失旧窗口的有效所有权。

验收：用两个真实 controller/窗口或两个进程验证：A 正在执行，B 打开被拒，A 的 Round/runtime_active/执行均不变；A 正常完成；真正崩溃并取得新锁后才 reconcile 为 interrupted。仅 store.acquire 的单元测试不能替代 controller 路径。

### 1.2 Git evidence 不丢本轮修改

现状：collector 从 changedFiles 排除所有 baseline 已 dirty 的路径，又用 dirty 路径是否首次出现判断 turn delta。因此同一文件上的本轮追加修改会消失。

要求：根据前后文件内容/状态和 Git 状态识别实际 delta；保留用户执行前改动的归属，同时记录本轮对同一文件的新增修改。支持已修改、已暂存、未跟踪、删除等场景；不能把整个工作区 diff 都归给 agent。区分“本轮贡献”“已有改动”“当前状态”。

验收：临时 Git repo 中分别修改原本干净与已 dirty 的文件；两次 continuation 修改同一个文件都能识别 delta；用户原有内容不会被虚称为本轮产物；删除、暂存与新增文件的 Result 描述准确。

### 1.3 Loop 时间预算与验证进程回收

现状：预算只在 turn 末尾且 completed 判断之后检查；默认 DSH prompt 无时限。补测 elapsed=7200001ms 时仍 completed。

要求：在进入 turn、执行验证和接受终态时检查剩余墙钟预算；执行中的长 turn/检查也有能停止继续占用资源的截止处理。不要把产品 End Round 伪装为 mid-turn cancel；若公开 ACP 不支持取消，明确使用运行时生命周期终止并记录 budget_exhausted，保存可取得的证据。关闭/终止必须有界，不能等待 session/close 永久卡住。

当前 `verify-permissions-impl.mjs` 在本次审查环境连续两次为 22/23：`timeout_tree_killed_no_late_write=false`。重新复现并记录 taskkill/子进程实际结果；区分实现问题与权限/环境限制，不能吞掉回收失败并宣称已终止。测试失败应能可靠传递到运行命令的退出结果。

验收：可控时钟覆盖 turn 前、验证前、刚好到达、超过预算仍返回模型响应等边界，超过不得 completed；短时真实超时验证无后续 turn，子进程树不再延迟写入。外部环境确实阻止回收时记录未通过和原因。

## 阶段 2 — Plan 必须改变 agent 的工作方式

现状：Plan/Vibe 都原样 `runtime.prompt(spec)`；模式只改变落库位置，没有原生 Plan Mode 或 guidance。

要求：

1. 核对当前安装版本公开 ACP/DSH 的 mode/config 能力；通过公开接口接入原生 Plan Mode，退出 Plan 时正确退出。同一 DSH Session 保持上下文。
2. 如果公开接口无法切换原生模式，使用明确的 Plan guidance 实现产品 Plan 行为，并记录该限制；不是要求用户在 Spec 前手写“只规划”。模型应输出方案、步骤、相关验证与待决事项，不直接进入功能实现。
3. Plan guidance 与文件权限分开：guidance 不是硬 sandbox，不能虚称只读；Session preset 不因模式自动升级。
4. 连续 Plan 仍复用一个 Round，保存每次 Spec 和完整计划；新增版本后默认显示最新版本，同时允许用户主动查看旧版本。

验收：同一明确开发需求分别在 Plan 和 Vibe 提交。Plan 得到方案且没有直接实现目标功能；Vibe 能执行实现。Plan→Vibe→Plan 的原生模式或 guidance 正确切换、上下文不丢；Plan×3 一 Round 三版本且页面默认最新版。用实际 runtime/安装后应用验证，不能只看数据库 mode。

## 阶段 3 — 自然语言 Loop，而非固定格式任务验证器

### 3.1 需求理解与决策

用模型参与理解完整 root Spec、评估进展和剩余事项。移除 `RequiredSpec` 正则解析器作为任意 Markdown 完成判定的唯一权威。现有内置文件/内容/字段检查可保留为证据工具，不能变成用户必须遵守的 Spec 语法。

建议正式 decision 至少包含：decision、reason、需求覆盖评估、未完成 required items、证据引用、已知反证、下一步行动。对结构化输出做 schema 校验和有限重试；引用不存在或不适用的 evidence 必须拒绝，格式错误不能 completed。

四条件仍成立：Spec 明确要求已完成、无已知 required item 未完成、有匹配任务的证据、workspace 无已知推翻结论的问题。模型可以判断语义覆盖；产品校验引用的真实证据、有效性、明显矛盾、预算和状态。不要要求程序为任意自然语言任务建立形式证明，也不要把模型的一句“done”当作足够证据。

完整 root Spec 始终可供评估，不能因 prompt 截断丢失末尾要求；代码块、标题、说明等由语义理解，不得静默丢弃。对已知不确定的事项如实 continue/blocked。普通回复中的 blocked 字样与 `[BLOCKED]` 只作候选信息，不能让正文标记绕过需求评估和事实记录。

### 3.2 默认权限下的真实验证路径

现状：workspace-write 下 shell tests/typecheck/build 被全部拒绝；只有完全访问才能执行。安全边界已经成立，但默认开发工作流因此不可用。

寻找并实测公开且能服从 Session preset 的执行路径，例如 DSH 已有受限执行能力/公开 sandbox；验证结果需要真实命令结果、产物或可核实行为证据。不要重新回到宿主 unrestricted spawn，也不要用工具 completed 或模型自报冒充 exit 0。用户不应普遍为了跑相关 tests 被迫升级 danger-full-access。

如果现有公开接口确实无法同时满足权限与可核实结果，明确交付最小复现、已尝试路径和产品限制；不要把“所有 shell 都 denied”记作默认代码任务验证已完成。可先完成其余功能，但此项仍是产品能力缺口。

### 验收 3

通过正式模型+controller+evidence+Result 路径运行，而非只手工填 fixture：

- 明确的自然语言代码任务：修复一个小型示例项目中的实际错误并保留原有行为，相关 tests 通过后能够 completed；不要求 Spec 写成“Create file…”或列解析器关键字。
- 同任务只修一半，即使部分检查通过也继续或真实非完成终态，Remaining 点明缺口。
- 非代码任务，例如生成有指定用途的文档，使用适配的内容/产物证据，不强制 tests。
- 模型自称完成但无实际产物/有效证据：不能 completed。
- 长 Markdown 含标题、代码块与末尾要求：均进入理解，未完成项不被遗忘。
- workspace-write 下实际相关检查可用且外部临时标记不能被越界修改；read-only 的写入仍被阻止。

保留次数、无进展、错误重试、单 Loop Round、真实停止原因的回归。无进展应参考有意义的变化与需求覆盖，重复写相同内容/重复同一通过检查不能无限重置计数。

## 阶段 4 — Result 汇总整个工作阶段

现状：Vibe finalize 只传最后一个 entry，ResultBuilder 只取回复第一段；Plan/Vibe 不执行验证，正常收口后几乎没有 Verification。

要求：

1. Result Builder 输入整个 Round 的 Spec/对话、执行结果、变更与有效证据。Summary 应总结本阶段成果，不能机械截取最后一句回复；Changes 区分新增、修改、删除及用户原有改动。
2. Verification 只能声明实际证明的事实；有实际测试证据则准确汇总，没运行则明确未验证，不能编造通过。Plan/Vibe 的实际执行证据也应被采集，不应只有 Loop 能形成 Verification。
3. Remaining 记录已知未完成、阻塞或验证不足事项。Round 被用户结束与任务目标达成是不同语义：用户 End Round 可以收口页面，但不能将已知失败/阻塞包装成任务已完成。
4. Vibe 保留整个 conversation，并在结束后顶部显示整个 Round 的 Result。切换模式与 End Round 共用正确 finalize 流程。
5. Loop 各终态均保存 decision 与可用 evidence，包括 blocked、预算耗尽和错误路径；最后 Result 显示具体原因/缺口，不只一句通用说明。失效的旧 passed 证据可作历史，但不能展示成当前有效验证。

验收：连续三个 Vibe turn 分别完成不同修改，final Result 覆盖整个阶段而非只第三条回复；其中一项失败/未验证时如实列出。Plan→Vibe→Loop 的收口与成果页面正确；失败的直接 turn 不应丢失其 Spec/可取得的输出和事实。

## 阶段 5 — 草稿、版本与安装后验收

- 修复 renderer `localDraftDirty` 的生命周期：成功 autosave/提交后的已提交 draft 可清理；执行期间写的新 draft 必须保留；异步 snapshot 不能覆盖更新的编辑。不是简单无条件重置 dirty。
- 修复 Plan versionIndex：新增版本默认最新，主动查看旧版时行为明确；不要因同 Round 组件未重建而一直停在 v1。
- 验证运行中浏览旧 Round、编辑下一 Spec、Source/MD 切换、Runner 收起/侧栏折叠/恢复及终态隐藏。
- 复跑 typecheck/build、已有域测试与本单新增正式路径测试；不要仅看 checks 数量，记录实际失败项和执行环境。
- 重新构建并安装 Windows 包，记录对应源码和包 hash。安装后验证 Plan/Vibe 的不同执行行为、自然语言 Loop 正反场景、默认权限下相关验证、旧 Session 恢复、两窗口独占与草稿竞态。

## 最终交付与签收

更新 `docs/v1-acceptance.md` 与架构说明，每条以通过/未通过/未运行记录命令和脱敏证据，说明确定性测试与真实模型测试的边界。提交推送 origin/main，报告架构取舍、关键修复、产品场景结果、剩余外部能力缺口。

签收重点是：**用户能用普通 Markdown 开发需求，获得实际计划、连续对话或自主持续执行，并回看整个阶段的可信成果。**正则测试、文件存在正例和安装成功都不能替代这条产品闭环。所有权限边界必须保留；已知限制如实交付，不宣称未实现的能力。
