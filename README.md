> **Repository moved:** Active OpenCode-backed Codey development now lives in `StupidArthur/codey-opencode` on its `main` branch. This branch is retained as the migration source/history checkpoint.

# Temporal Workspace — OpenCode Edition

Temporal Workspace is an Electron + React desktop workspace focused on the interaction and presentation layer around coding agents: Temporal Rounds, Plan/Vibe/Loop modes, Result documents, a live Runner, evidence, and verification.

This branch replaces DeepSeek Harness with **OpenCode v1.18.31** as the execution core while keeping the product UX and Temporal domain model.

## Runtime architecture

```text
Temporal Workspace
├─ Electron / React UI
├─ Session → Round → Result product model
├─ Plan / Vibe / Loop behavior
├─ Runner event projection
├─ Evidence / verification / Result projection
└─ OpenCodeRuntime
   └─ bundled OpenCode CLI v1.18.31
      ├─ private Codey Plan agent
      ├─ private Codey Build agent
      ├─ OpenCode tools / MCP / compaction
      └─ OpenCode Session persistence
```

Mode mapping:

- **Plan** → a private OpenCode primary agent with edit, bash, task, and external-directory access denied. Codey adds only the plan-document formatting guidance.
- **Vibe** → a private OpenCode build agent.
- **Loop** → Codey's LoopController drives repeated turns through the same private OpenCode build agent, then applies Codey's evidence and completion gate.

All three modes reuse one OpenCode Session. OpenCode owns conversation context, tool execution, native compaction, and backend persistence. Codey's SQLite database stores only product projection data such as Rounds, drafts, Result documents, evidence, and the OpenCode Session id.

## Pinned backend

The backend is intentionally frozen at:

```text
OpenCode CLI: 1.18.31
```

`pnpm prepare:opencode` downloads the official Windows x64 release archive and verifies its SHA-256 before copying `opencode.exe` into `vendor/opencode`.

The Windows installer bundles that binary under:

```text
resources/opencode/opencode.exe
```

The application checks `/global/health` at runtime and rejects a backend whose reported version is not `1.18.31`.

## Runtime isolation and permissions

Each app runtime launches a local authenticated `opencode serve` process bound to `127.0.0.1`. OpenCode data/config/cache are isolated under this edition's Electron `userData` directory.

Requests are routed to the selected Workspace with OpenCode's public `x-opencode-directory` mechanism.

Codey creates private, randomized OpenCode primary-agent names for Plan and Build so project-level `agent.build` / `agent.plan` configuration cannot redefine Codey's execution agents. The Session permission preset is also re-applied through `OPENCODE_PERMISSION` after normal OpenCode config loading.

OpenCode permissions are an agent/tool permission system, **not an OS-level filesystem sandbox**. In particular, `workspace-write` should not be interpreted as the same security boundary as DSH's ACL sandbox. `read-only` denies edit and shell execution; `danger-full-access` permits external-directory access.

## Prewarming

OpenCode startup is paid while the user is editing rather than after Submit:

- Session open schedules a delayed warmup.
- The first draft save or mode change starts warmup immediately.
- Submit reuses the same in-flight startup Promise if warmup has not completed.
- Warmup failures are logged but do not block editing; Submit retries through the normal runtime path.

## Development

Requires Node 24 and pnpm 11.

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm probe:opencode
```

Prepare and smoke-test the pinned Windows backend:

```text
pnpm prepare:opencode
pnpm probe:opencode:smoke
```

Build the Windows x64 installer:

```text
pnpm dist:win
```

## Diagnostics

Per-Session diagnostic logs are written by default to:

```text
D:\codey-log\session-<product-session-id>.jsonl
```

Important OpenCode events include runtime startup, health/version checks, Session create/resume, prompt timing, SSE events, tool lifecycle, compaction, cancellation, evidence phases, and snapshot timing.

## Branch

This edition is developed on:

```text
backend/opencode-v1.18.31
```

The DSH implementation remains on the main product lineage and is not dynamically selectable in this edition. Keeping the backends as separate editions avoids a large runtime-switching compatibility layer.
