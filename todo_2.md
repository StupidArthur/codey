# TODO 2 — 核准 DSH 上游报告的复现证据

> **Historical / completed:** 这是已完成阶段的任务记录；其调查描述 SDK resume 缺口，但产品当前统一走公开 ACP，V1 已关闭。最终事实见 `docs/architecture-review.md` 与 `docs/v1-acceptance.md`。

本任务由**一个 agent 独立完成**，不要再委派 agent。目标是让面向 DSH 上游的报告与可运行探针严格一致。只处理证据和表述，不启动 Runtime、Result Builder、Loop 或 Windows 打包开发。

## 先读

1. `docs/dsh-upstream-resume-report.md`：唯一面向上游的报告；其他设计和验收文档不要作为上游 issue 正文。
2. `scripts/probes/dsh-runtime-p0.mjs`、`scripts/probes/dsh-runtime-diag.mjs`、`scripts/probes/dsh-acp-resume.mjs`：逐项核对报告中的步骤、输出和断言。
3. `docs/p0-acceptance.md`：确认 P0 gate 的当前状态，不把 SDK resume 失败写成产品已通过。
4. 仓库实际安装的 `@deepseek-ai/dsh-sdk-client`、`@deepseek-ai/dsh-sdk-jsonrpc-server`、`@deepseek-ai/dsh-agent` 版本及相应公开源码：核对协议方法和 `agents.create` / `agents.resume` 的论据。不要读取或解析 DSH 私有 session JSONL。

## 阶段 1：校准报告用语

- 报告目前的 “Process A / Process B” 容易被理解成两个独立的 Node 探针进程。实际 `dsh-runtime-p0.mjs` 在**同一个 Node 宿主进程**内依次创建两个 `DeepSeekHarness`，每个 harness 启动一个新的 DSH runtime 子进程。将复现步骤、摘要和表格写到这个精度；ACP 对照探针也由一个宿主进程先后启动两个 ACP 子进程。
- `first-close` 当前在 `close()` 失败时仍记录 `passed: true`。在探针能证明关闭成功前，报告不得声称 “subprocess reaped”。
- 报告中的错误码 `-32603` 需要能从探针结构化输出或附带的脱敏实测记录直接核对。如果探针拿不到该字段，就把报告改成只陈述已证明的错误名称与消息，并标明错误码尚未由该探针确认。
- 为上游核对根因提供对应版本的源码位置或稳定链接；区分源码直接证明的事实与根据现象作出的推断。不要声称已经验证跨 profile resume 等价性。

**阶段验收：**报告中的每一条“Observed”都能指向探针输出或公开源码；复现步骤明确宿主进程与 DSH 子进程的边界；未验证事项仍明确标为未验证。

## 阶段 2：修正最小探针证据

- 让 `dsh-runtime-p0.mjs` 的 `first-close` 真实反映 `close()` 成败；关闭失败时以脱敏错误信息记录失败并使总状态失败。第二个 harness 的关闭也要有可核对的状态，不能悄悄吞掉错误。
- 失败行尽可能记录 JSON-RPC 错误的 `name`、数值 `code` 与截断后的脱敏 `message`；不要输出密钥、prompt、模型回答或随机记忆 token。只记录实际存在的字段，不硬编码 `-32603`。
- 保持探针原有的独立临时 DSH home、退出码语义和 resume 上下文断言。不要为了让探针通过而改用 ACP 替代 SDK 路径；ACP 探针是对照组。
- 如诊断探针也被报告引用，检查其关闭状态和错误字段是否存在同类误报，按相同原则修正，或在报告中明确其证据范围。

**阶段验收：**无凭证运行时仍正确跳过模型阶段；有凭证运行时输出足以区分 SDK resume 失败、关闭失败与上下文断言失败。仅凭 `passed: true` 的关闭行即可追溯实际 `close()` 成功，而不是 `catch` 吞错后的默认值。保留一份脱敏运行结果供上游复现，不提交凭证或原始对话。

## 交付

完成后汇报修改的文件、实跑命令、各阶段结果和仍未核实的断言。需要真实模型凭证才能验证的项目，如果当前环境没有凭证，明确标记“未运行”，不能推定通过。只将 `docs/dsh-upstream-resume-report.md` 作为上游 issue 正文；两个 probe 可作为复现附件。**不要代替我向上游提交 issue 或联系维护者。**
