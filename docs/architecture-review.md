# Temporal Workspace — Architecture Review

Date: 2026-09-26  
Status: **implementation accepted except packaging/runtime gates listed below**

## Architectural ownership

DSH is authoritative for conversation, execution, and model context. SQLite stores only the Temporal projection: sessions, Rounds, Plan versions, Vibe entries, evidence, Results, draft revisions and leases. The renderer never touches the filesystem or DSH directly; every IPC request is bound to its sending window's controller.

## Process and data boundaries (implemented)

```text
React Renderer
  │ typed, narrow API (src/shared/contracts.ts)
Preload / IPC  (src/preload/index.ts, src/main/index.ts)
  │
Electron Main  (one WindowController per BrowserWindow)
  ├─ WindowController: window ↔ one product session, snapshot + lease lifecycle
  ├─ RoundEngine: Plan/Vibe/Loop boundaries, Plan versions, Vibe entries
  ├─ DshRuntime: unified public ACP execution (session/new | session/resume)
  ├─ SessionDiscovery: public ACP session/list discovery
  ├─ EvidenceCollector: git / filesystem / runner-event facts
  ├─ VerificationExecutor: product-owned command runner (real exit codes + stamps)
  ├─ ResultBuilder: deterministic Summary/Changes/Verification/Remaining
  ├─ LoopController: execute → collect → evaluate → continue/terminal
  ├─ LoopEvaluator: four-condition completion gate + check suggestion
  ├─ ProductStore: SQLite projection, draft revisions, cross-process leases
  └─ CredentialVault: OS-protected credential storage
```

## Decisions fixed

1. Windows is the first release target; the installer bundles the version-matched DSH.
2. Model and credential configuration lives in-product; secrets are outside SQLite, logs, IPC snapshots and Results.
3. One window owns one Session. Exclusivity is enforced by a SQLite row lease (`session_leases`) so it holds across windows **and across app processes**, not only inside one main process.
4. Loop defaults: 16 internal continuations, two hours wall clock, three consecutive no-progress cycles, two same-error retries.
5. Legacy DSH history is read-only and inherited; Temporal Round 1 starts with the first submission through this product, on the existing DSH Session.
6. Pinned pair: `@deepseek-ai/dsh@0.1.7-rc.2`, `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2`, `@agentclientprotocol/sdk@1.4.0`.

## Execution path decision (phase A)

The SDK `sdk` profile cannot resume a persisted session: its JSON-RPC server always calls `ctx.agents.create(...)` and never `agents.resume(...)`, so a known persisted id fails with `session "<id>" already exists`. The public SDK wire exposes no resume method (see `docs/dsh-upstream-resume-report.md`, kept unchanged as the upstream gap report).

Because the public **ACP** `session/resume` *does* inherit context across processes (verified by `scripts/probes/dsh-acp-resume.mjs` and `scripts/probes/dsh-acp-exec.mjs`), execution was unified on the public ACP profile (`dsh --profile acp`):

- fresh session → `session/new`
- persisted session → `session/resume`
- one `session/prompt` per turn; the DSH session id is persisted after the first successful create
- provider/model are injected with a generated `--patch`; credentials via the documented env mapping; the session permission preset maps to `DSH_PERMISSION_MODE`

This is a deliberate divergence from the original HarnessClient/SDK single-client design. It uses only public interfaces, touches no private files or `node_modules`, and keeps new and resumed sessions on one transport so context never has to be replayed into the prompt.

## Acceptance gates

| Gate | Required evidence | Current result |
| --- | --- | --- |
| G0 — package closure | Reproducible install of matched DSH + SDK | Passed locally with pinned lockfile |
| G1 — runtime | Initialize, first/sequential prompt, cross-process resume, notifications, close | **Passed on public ACP** (real credential, 2026-09-25): new session, sequential prompt with inherited context, cross-process `session/resume`, file write, tool/thought/message updates. SDK-resume remains an upstream gap and is no longer on the execution path |
| G2 — discovery/history | Public API lists sessions by canonical cwd; legacy history is explicit | Passed: ACP `session/list(cwd)` with pagination, product/discovery merge and dedupe; legacy history is unreadable by public API and shown as the read-only `Historical transcript unavailable` placeholder, never faked |
| G3 — persistence | Migration, draft revision race, restart reconciliation, cross-process lease | **Passed by `scripts/probes/temporal-domain.mjs`**: migrations, default permission, draft revision clear-only-if-unchanged, execution start/finish ordering, interrupted reconcile, evidence/result projection, same-process and cross-process lease block/release/crash-TTL |
| G4 — semantics | Plan revisions, Vibe entries, Loop state machine, four-condition completion gate and terminal states | **Passed by `temporal-domain.mjs` + `loop-gate-impl.mjs`**: Plan reuse with two versions, Plan→Vibe finalize, Vibe accumulation + top Result, Loop new Round terminal; no-progress, same-error, 16-continuation budget, structured `[BLOCKED]`, wall-clock budget boundaries, evidence-complete terminals, and all acceptance-2 counterexamples rejected (partial A, unrelated test, no evidence, unknown/phantom evidence, stale-after-modify, deleted artifact, failed check, long-spec tail, wording variations) |
| G5 — result trust | Evidence-backed Verification and truthful terminal reason | **Passed by `temporal-domain.mjs` + `loop-gate-impl.mjs` + installed-app probes**: a model claim with no collected evidence produces an empty Verification set; Verification lines come from product-executed checks with real exit codes (tool completion alone is not a pass); the `completed` reason lists actual req coverage with evidence IDs; a blocked/failed/budget terminal carries its real reason and is never rendered as success |
| G6 — desktop | Typecheck, build, startup, multiple windows, packaged install | Typecheck/build pass; multi-window and installed-app runtime verification are the remaining items (see `docs/v1-acceptance.md`) |

Passing a build is not acceptance of a gate that requires runtime behavior.

## Implementation notes

- **Evidence is collected, not asserted.** `EvidenceCollector` snapshots the real workspace (git status/diff for repos, bounded mtime walk otherwise) before and after each turn, distinguishing pre-existing user changes (`preexisting`) from this turn's contribution, and folds structured DSH tool-call facts into the bundle. `ResultBuilder` is deliberately deterministic: it can only emit a Verification line from a product-executed check that produced an exit code, so a model sentence like "all tests passed" can never fabricate one. If an execution produces no verification evidence, the Result says so rather than claiming success.
- **Loop completion is a four-condition gate, never the model's claim.** `LoopEvaluator.decide` extracts every requirement line from the root spec (no truncation), and each item must be covered by currently-valid, relevant verification that the product's own `VerificationExecutor` ran to exit 0 (validity compares run stamps against the live file states and the turn in which a target last changed). Completion additionally requires no pending/unknown item and no known counter-evidence: failed checks, unresolved DSH tool failures, artifacts modified or deleted after their check. `cmd /c` invocations pass `windowsVerbatimArguments` so inner quotes survive Node's default re-quoting. The `completed` reason is composed from the actual coverage (`req-N (evidence-id)`), never a canned sentence. Remaining gaps and workspace issues become the next continuation prompt; the model is told it may start a reply with the structured `[BLOCKED]` marker only when genuinely blocked. Budgets yield `budget_exhausted`, repeated identical errors `failed`, and the marker `blocked`.
- **Plan/Vibe reuse, Loop isolation.** Plan and Vibe submissions reuse one open Round (Plan appends a version, Vibe appends an entry); switching mode, `End Round`, or the first Loop submit finalizes the open Round. Loop internal turns never appear as sidebar Rounds; each Loop submit creates exactly one terminal Round and one Result.
- **Crash honesty.** A Round that is `runtime_active` at startup is reconciled to `interrupted`, never `completed`. Terminal writes clear `runtime_active` in the same statement, and the engine tolerates an already-inactive runtime.
- **Draft race.** Draft writes bump a revision; after a submit, the store clears the draft only if it still matches the submitted revision, so edits made while running survive a restart.

## Known limitations / follow-ups

- The Loop evaluator is a deterministic four-condition evidence gate (full requirement coverage, valid/relevant passing checks, no pending/unknown, no counter-evidence), not a model-driven requirements evaluator. This is intentional for V1 trustworthiness and is documented as a simplification of the design's evaluator.
- Permission presets map to DSH's documented `DSH_PERMISSION_MODE`; a real-model probe (`dsh-permission-impl.mjs`) and the installed-app `readonly` scenario confirm writes are denied under `read-only` while `workspace-write` succeeds.
- DSH's tool layer is intermittently unreliable on this machine: sampling shows the `write` tool failing occasionally (retried by the model) and the system `pwsh` (PowerShell 7) is not installed, while `cmd` is available. Public ACP does not transmit tool error text or exit codes, so the literal `0xC0000142`/`3221225794` from an earlier screenshot could not be confirmed at the tool layer. The product's verification therefore always runs through its own `cmd`-based executor and records real exit codes, so DSH tool failures surface only as observed facts / known issues, never as passing evidence.
- Legacy transcript reading remains unavailable by public interface; the placeholder is the V1 contract.
