# DSH 集成现状与公开接口缺口

日期：2026-09-25  
供 GitHub 审阅使用；结论针对仓库锁定的 `@deepseek-ai/dsh@0.1.7-rc.2` 与 `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2`，不推断其他版本。

## 一句话结论

**新 Session 的执行入口已经接上 SDK，但“按 Workspace 发现已有 DSH Session → 浏览旧历史 → 在原 Session 上继续”的完整路径尚未打通。** 其中历史读取是最明确的公开接口缺口。当前代码不能被视为 V1 功能完成。

## 产品需要的能力与目前所见

| 能力 | 公开接口现状 | 仓库现状 |
| --- | --- | --- |
| 启动运行时、初始化、提交 Spec、接收事件、关闭 | SDK 支持 | `DshRuntime` 已接入；无密钥环境下初始化握手已通过 |
| 按 canonical Workspace 路径发现旧 Session | SDK wire 不提供；公开 ACP `session/list(cwd)` 支持分页列表 | ACP 适配器尚未实现；启动页目前只列产品 SQLite 中已记录的 Session |
| 读取旧 Session 对话供只读 History 页面展示 | SDK wire 不提供；ACP 明确不支持 `session/load` 或旧更新回放 | `SessionDiscovery.readHistory()` 明确报不可用；History 无真实数据来源 |
| 已知 Session ID 继续原有上下文 | SDK 可传入 Session ID；ACP 有 `session/resume` | 代码有按 ID 提交路径；**尚未用真实模型完成跨进程上下文恢复验证** |

依据：[SDK 协议方法表](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/protocol/README.md)只列出 `initialize`、`session/prompt`、`shutdown` 三个请求；[SDK 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)描述了运行和指定 Session ID 的 API；[ACP 说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)列出 `session/list(cwd)`、`session/resume`，并明确说明旧 transcript 不回放、`session/load` 不支持。仓库安装的同版本 ACP README 也包含相同限制。

## 对当前需求的影响

需求要求先选目录，显示该目录全部 DSH Session；旧 Session 要有只读 History，并在第一次 Temporal 提交时沿用原 DSH 上下文。现在启动页只能可靠展示本产品 SQLite 中已有的记录，不能宣称已发现目录内全部 DSH Session。也不能用 SQLite 记录代替 DSH 原生历史，或从私有 JSONL 倒推 Plan/Vibe/Loop/Round。

这不阻止新 Session 的桌面骨架继续开发；**阻止的是已有 Session 兼容功能的验收**。如无受支持的历史读取接口，只读 History 页面需调整产品要求或等待上游增加公开能力。

## 可复核的代码与命令

- `src/main/dsh/DshRuntime.ts`：SDK 运行时封装。
- `src/main/dsh/SessionDiscovery.ts`：发现和历史读取尚未接入时显式报错。
- `src/main/WindowController.ts`：`listSessions()` 目前只读取 ProductStore。
- `scripts/probes/dsh-runtime-p0.mjs`：P0 探针。无 `DEEPSEEK_API_KEY` 时只验证初始化与关闭；配置测试凭证后才可验证两次提交及跨进程恢复。探针不打印凭证或对话正文。

```text
pnpm.cmd install
pnpm.cmd typecheck
pnpm.cmd build
node scripts/probes/dsh-runtime-p0.mjs
```

已在当前 Windows 环境通过 `typecheck` 和 `build`；DSH 初始化握手通过。真实 prompt、事件完整性、跨进程 resume、ACP discovery、安装包内启动及旧 History **尚未验收**。

## 希望审阅者帮助确认

1. 对 `0.1.7-rc.2`，是否存在**公开且稳定**的旧 Session transcript/消息读取或导出接口？若有，请指出包、方法和版本。只读 History 不需要重新执行旧 turn。
2. 推荐如何在 SDK 执行进程旁使用 ACP `session/list(cwd)`，并保证它们看到同一持久 Session 集合？是否有更合适的公开 discovery 接口？
3. `DeepSeekHarness.session(existingId)` 后第一次 `run()` 是否保证从磁盘恢复完整旧上下文？有哪些跨版本、并发打开或 cwd 不匹配的限制？

在这些问题得到可运行验证前，仓库会继续保留显式缺口，不解析 DSH 私有存储，也不展示伪造历史。
