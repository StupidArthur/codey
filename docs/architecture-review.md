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
  ├─ ResultBuilder: deterministic Summary/Changes/Verification/Remaining
  ├─ LoopController: execute → collect → evaluate → continue/terminal
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
| G4 — semantics | Plan revisions, Vibe entries, Loop state machine and terminal states | **Passed by `temporal-domain.mjs`**: Plan reuse with two versions, Plan→Vibe finalize, Vibe accumulation + top Result, Loop new Round terminal; Loop no-progress, same-error, 16-continuation budget, blocked and evidence-complete terminals |
| G5 — result trust | Evidence-backed Verification and truthful terminal reason | **Passed by `temporal-domain.mjs`**: a model claim with no collected evidence produces an empty Verification set; a failed/budget terminal carries its real reason; Verification lines exist only when evidence does |
| G6 — desktop | Typecheck, build, startup, multiple windows, packaged install | Typecheck/build pass; multi-window and installed-app runtime verification are the remaining items (see `docs/v1-acceptance.md`) |

Passing a build is not acceptance of a gate that requires runtime behavior.

## Implementation notes

- **Evidence is collected, not asserted.** `EvidenceCollector` snapshots the real workspace (git status/diff for repos, bounded mtime walk otherwise) before and after each turn, and folds runner tool events into verification claims. `ResultBuilder` is deliberately deterministic: it can only emit a Verification line from a collected claim, so a model sentence like "all tests passed" can never fabricate one. If an execution produces no verification evidence, the Result says so rather than claiming success.
- **Loop completion is evidence-gated.** `LoopController` treats the model's own "done" as a candidate only; a turn can complete only when real verification passed, the response reports no block, and no unresolved error remains. Remaining gaps become the next continuation prompt. Budget exhaustion yields `budget_exhausted`; repeated identical errors yield `failed`; an explicit block yields `blocked`.
- **Plan/Vibe reuse, Loop isolation.** Plan and Vibe submissions reuse one open Round (Plan appends a version, Vibe appends an entry); switching mode, `End Round`, or the first Loop submit finalizes the open Round. Loop internal turns never appear as sidebar Rounds; each Loop submit creates exactly one terminal Round and one Result.
- **Crash honesty.** A Round that is `runtime_active` at startup is reconciled to `interrupted`, never `completed`. Terminal writes clear `runtime_active` in the same statement, and the engine tolerates an already-inactive runtime.
- **Draft race.** Draft writes bump a revision; after a submit, the store clears the draft only if it still matches the submitted revision, so edits made while running survive a restart.

## Known limitations / follow-ups

- The Loop evaluator is a deterministic evidence gate (verification presence, error signatures, changed-file progress), not a model-driven requirements evaluator. This is intentional for V1 trustworthiness and is documented as a simplification of the design's evaluator.
- Permission presets are mapped to DSH's documented `DSH_PERMISSION_MODE`; a real-model probe that blocks a write under `read-only` is pending a credential.
- Legacy transcript reading remains unavailable by public interface; the placeholder is the V1 contract.
