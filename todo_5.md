# TODO 5 — 修复虚假需求覆盖与验证执行器权限绕过

## 目标与工作方式

基线 `b1e1b4e`。由同一个 agent 独立连续完成本单，不委派其他 agent。完成实现、针对性测试、打包、安装后验证和文档闭环，再提交推送 `origin/main`。不要把“测试数量增加”当作完成；下面的具体反例必须经过正式代码路径。外部能力确实不可用时准确报告未运行，继续完成独立项。不要发布 release 或联系上游。

当前有两个 V1 阻塞：

1. `LoopEvaluator.suggestChecks()` 将包含路径的任意要求映射为 `if exist`，并把该检查的 `covers` 指向整条 requirement；无路径但含 create/实现 等词时，甚至拿任意首个变更文件存在性来覆盖功能要求。这让空文件或无关文件也能证明“完成”。
2. `VerificationExecutor.run()` 从 Electron Main 直接 `spawn(cmd, args)`，没有 Session permission/sandbox。`Run:/Verify:` 任意命令可绕过 DSH 的 read-only 与 workspace-write 边界；`cwd` 在 workspace 不等于文件权限受限。

## 先读

- `todo_4.md` 与 `requirement/dsh-final-system-design.md` 的四条件 completion、权限和 Verification 规则。
- `src/main/loop/{RequiredSpec,LoopEvaluator,LoopController}.ts`。
- `src/main/evidence/{VerificationExecutor,evidence,EvidenceCollector}.ts`。
- `src/main/rounds/RoundEngine.ts`、`src/main/WindowController.ts`、`src/main/dsh/DshRuntime.ts` 的 Session preset 与调用链。
- `scripts/probes/loop-gate-impl.mjs`、`temporal-domain.mjs`、`installed-app-e2e.mjs`、`docs/v1-acceptance.md`。

## 阶段 A — 将检查结果与需求满足严格分开

### 实现要求

1. 保留 root Spec 原文及稳定 requirement ID，但每条 requirement 必须有完整验收语义。记录至少：原文、可核实的验收条件、状态、证据 ID、覆盖范围和未覆盖部分。不得把 `covers: [req-N]` 这种由检查生成器自己写入的声明直接当作事实。
2. 分离两层事实：
   - check fact：实际检查什么，得到什么结果，如“文件存在”“内容匹配”“测试命令退出 0”；
   - requirement assessment：这些事实是否足以覆盖整条要求，哪些内容仍 pending/unknown。
   只有第二层校验确认整条要求已满足，才允许 satisfied。
3. 删除“任意首个变更文件存在即可覆盖无路径功能要求”的 fallback。无法自动判定的自然语言需求保持 unknown，交给后续执行/evaluation 获取有针对性的证据，不能猜测满足。
4. 文件存在检查只证明存在。仅当要求本身明确**只要求创建/存在某文件**，且没有内容、行为、格式等额外条件时，才可以覆盖整条要求。文件类型要检查：同名目录不能满足文件要求。
5. 对要求内容、结构、功能、行为的任务，选择对应的内容断言、结构校验、相关测试或实际行为检查。例如：
   - “创建 a.txt，内容为 XYZ” → 文件类型 + 内容匹配；
   - “创建配置文件，字段 enabled=true” → 解析配置并验证字段；
   - “修复函数并添加测试” → 功能/测试文件变化与相关测试结果的证据，单纯文件存在或编译通过不够；
   - “新增登录功能” → 没有明确验收方式时不能用任意文件替代功能验证。
6. 同一行多条件、多个文件、多个行为必须全部保留。Markdown 标题中如果含实际要求不能静默丢弃；代码块和说明文字不能误解析成未经授权的执行命令。不能靠只支持某种 Spec 格式来默默削弱任意 Markdown 的产品契约；不能识别时报告 unknown。
7. 模型可以提出验收方式和覆盖判断，但不能凭模型声明产生 passed。最终门禁仍校验真实 evidence、相关性、有效期和 required item 的未覆盖部分。显式 `Run:` 命令只证明该命令的结果，不能自动覆盖邻近或整段的其他要求。
8. 保留已有文件 stamps/时序失效检查；文件内容检查建议使用内容摘要避免同大小、同 mtime 的修改被误认作旧状态。旧失败被修复后需有针对同一检查对象的有效复测；不能仅凭“同工具名后来 completed”清除任意旧失败。

### 必须通过的反例

| 输入与实际状态 | 预期 |
| --- | --- |
| 创建 a.txt，内容必须 XYZ；实际为空或 ABC | 不得 completed，指出内容未满足 |
| 创建 a.txt；实际创建同名目录 | 不得 satisfied |
| 同一行要求 a.txt 和 b.txt；仅 a.txt 存在 | b 未满足，不得 completed |
| 创建 JSON 且 enabled=true；实际 {} | 不得 completed |
| 实现登录功能；只修改无关 NOTES.md | 不得 satisfied |
| 添加测试并修复功能；只通过 typecheck | 不得覆盖整条要求 |
| Run: exit 0 通过；另一条业务要求缺失 | 业务要求仍 pending/unknown |
| 要求仅出现在 Markdown 标题或长 Spec 末尾 | 不能被静默丢弃 |
| 验证后改为相同长度的错误内容 | 旧内容证据失效 |

正例至少包括：纯文件创建任务、文件内容任务和明确行为测试任务。通过正式 collector/executor/evaluator/controller，而非手工编造 VerificationRun 的 covers/outcome 来证明端到端通过。单元测试可用 fixture，但必须另有正式路径集成反例。

## 阶段 B — 验证执行器服从真实权限边界

### 设计要求

1. 先梳理正式调用链：Session permission → RoundEngine → LoopController → VerificationExecutor。把 workspace canonical path、Session preset、检查来源及允许能力显式传入；默认缺少 preset 时拒绝执行，不能退化为 unrestricted。
2. 不以“这是验证命令”判断安全。测试/build/lint 可能写文件、执行脚本、访问网络或启动子进程；来自 Spec 的命令也可能含重定向、链式执行、路径逃逸。不要用命令名白名单或正则作为任意 shell 的安全边界。
3. 优先采用现有公开且可验证的 sandbox 执行机制，让验证子进程与 DSH 服从同一 Session 权限。如果 Windows 没有足够的公开 sandbox 能力：
   - 内置文件存在、内容、结构检查改为受路径约束的只读 API，不需要 shell；
   - 任意 shell 验证在无法 enforcement 的 preset 下不执行，记录 unknown/denied 和真实原因；
   - 不悄悄切 danger-full-access，不自动扩大权限，不为了获得 passed 直接在宿主执行。
4. read-only：任何写入、删除、重命名及子进程写入都必须实际被阻止。workspace-write：不能修改 workspace 外文件。明确处理 `..`、绝对路径、Windows 大小写/UNC/盘符、junction/symlink 等路径逃逸。即使 cwd 在 workspace，也不能认为命令受限。
5. 显式要求的用户命令仍需遵守 Session 权限；不要新增默认授权绕过。无法执行时生成可操作的 Remaining/blocked 原因，让用户自行调整 Session 配置。
6. 运行时保存结构化退出码、signal、来源和适用权限。命令/输出在持久化和展示前脱敏。超时应终止验证进程树并确认回收，不能留下继续写文件的子进程。

### 必须通过的权限测试

在独立临时目录创建 workspace 与 outside，两者都有带随机标记的文件；禁止碰真实用户文件。

| preset / 请求 | 预期 |
| --- | --- |
| read-only：内置存在/内容读取 | 可验证且无任何写入 |
| read-only：Run 命令写 workspace 文件 | 被阻止或拒绝执行，文件不存在/内容不变 |
| read-only：删除/重命名已有文件 | 文件与标记保持不变 |
| read-only：脚本启动子进程写入 | 同样被阻止，不得仅拦第一层 |
| workspace-write：写 workspace 外绝对路径或 ../outside | 外部标记保持不变；不能 passed |
| workspace-write：经 junction/symlink 指向 outside 写入 | 拒绝/受 enforcement；外部不变 |
| preset 缺失或无可用 sandbox | fail closed，明确记录，不启动 unrestricted shell |
| 长时间验证超时且有子进程 | 进程树结束，无后续写入 |

必须至少有一个测试经正式 Loop Spec 的 `Run:/Verify:` 路径触发，而非只直接调用一个安全 helper。安装后的 read-only 场景也必须包含“验证阶段写入企图”，此前只证明 DSH 工具审批的用例不能替代此验收。

## 阶段 C — 集成与安装后签收

1. 复跑 `pnpm.cmd typecheck`、`pnpm.cmd build`、新增 gate/权限测试、`temporal-domain.mjs`。旧 Session、read-only、Loop budget 和 Result 的必要回归均需通过。
2. 重新构建 `pnpm.cmd dist:win`，安装当前构建，记录包 hash/源码 commit（构建时可使用待提交源码并注明）和安装版本，避免沿用旧二进制。
3. 安装后真实模型完成两个 Loop 场景：
   - 正例：创建指定内容文件并验证其内容，coverage 指向真实内容证据，completed；
   - 反例：文件已创建但内容错误或其中一个必需文件缺失，即使另一检查退出 0，也不能 completed，Result 明确显示未满足项。
4. 安装后 read-only 的正式验证阶段尝试写入，证明实际拒绝；检查 workspace/outside 标记和子进程状态。若无法实现 Windows enforcement，则按阶段 B 的安全降级拒绝 shell，并如实报告该能力限制。
5. 更新 `docs/v1-acceptance.md`、`docs/architecture-review.md`：每条证据区分“检查通过”与“需求已满足”；权限执行器能力及限制写清楚；旧错误的 passed 结论不能继续被引用为新 gate 已通过。

## 最终交付与签收标准

提交推送后报告 commit、根因与架构取舍、新增正式路径反例、安装后二进制与实测结果、仍受限制的验证类型。本单签收要求：

- 空文件、错误内容、无关文件或无关检查不能满足包含额外语义的 requirement。
- Spec 中的验证命令不能绕过 read-only/workspace-write；无法执行的检查明确 unknown/denied，不能 passed。
- 正向真实任务仍可基于对应内容/行为证据 completed；状态、数据库与 Result 一致。
- 通过/未通过/未运行可追溯到实际命令与脱敏证据。真实外部限制如实保留，不能以“完整四条件门禁已实现”替代证据。
