# Temporal Workspace

> **V1 status: accepted and development closed.** Current implementation facts and frozen boundaries are recorded in [`docs/v1-acceptance.md`](docs/v1-acceptance.md) and [`docs/architecture-review.md`](docs/architecture-review.md).

Electron + React desktop application for DeepSeek Harness (DSH). V1 is accepted and closed; the final design and implementation record lives in `requirement/` and `docs/`.

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

`@deepseek-ai/dsh` is pinned at `0.1.7-rc.2`; the runtime and discovery use public ACP (`dsh --profile acp`). Persistence uses Electron's built-in `node:sqlite` / `DatabaseSync`. The Windows installer command is `pnpm.cmd dist:win`; the installed Windows V1 passed acceptance.

## Integration status

- Session discovery uses public ACP `session/list(cwd)`. Existing DSH transcripts remain unavailable through a public read API; the product displays `Historical transcript unavailable` and never parses private JSONL. Session resume uses ACP `session/resume`.
- Plan is a product guidance path; Loop completion is model-assessed and product-validated; Results summarize the whole Round. Final behavior and known boundaries are recorded in the acceptance document.
