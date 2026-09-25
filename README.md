# Temporal Workspace

Electron + React desktop shell for DeepSeek Harness (DSH). The repository is in the architecture and first-integration stage; the product design lives in `requirement/`.

## Current structure

- `src/main`: window lifecycle, typed IPC handlers, DSH adapter, app-local SQLite projection, credential vault.
- `src/preload`: narrow `contextBridge` API; the renderer has no Node access.
- `src/renderer`: workspace launcher, timeline, Spec editor, runner, and model settings.
- `src/shared/contracts.ts`: cross-process data and IPC names.

One window owns one product session and one DSH runtime. A process-wide lock prevents the same product or DSH session from opening in two windows. DSH owns conversation history; SQLite stores only product metadata, rounds, drafts, and non-secret model settings. Credentials are encrypted with Electron `safeStorage` in the app data directory.

## Development

Requires Node 24 and pnpm 11. On Windows PowerShell, use `pnpm.cmd` if script execution is restricted.

```text
pnpm.cmd install
pnpm.cmd typecheck
pnpm.cmd build
pnpm.cmd dev
```

`@deepseek-ai/dsh` and `@deepseek-ai/dsh-sdk-client` are pinned together at `0.1.7-rc.2` (the newest published `next` release on 2026-09-25). The Windows installer command is `pnpm.cmd dist:win`. The builder keeps dependency files outside ASAR so the SDK can spawn the packaged DSH entry through Electron's Node mode.

## Integration status

- The SDK initialization handshake has been exercised with the bundled npm package. A model turn still requires a configured credential and an end-to-end test.
- The current public SDK has no Session list or history-read method. `SessionDiscovery` exposes this gap explicitly. Existing DSH sessions are not yet discoverable from the launcher, and imported history cannot yet be rendered. A public ACP listing adapter and a public history-read route need verification before claiming those features.
- Plan and Vibe currently store the raw DSH final response. Loop, Evidence Collector, and Result Builder are not yet wired; Loop submission fails explicitly rather than reporting a fabricated result.
