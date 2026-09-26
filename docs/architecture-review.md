# Temporal Workspace — Architecture Review

Date: 2026-09-26 (updated for TODO 5)  
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
  ├─ EvidenceCollector: git / filesystem / runner-event facts (bounded content hashes)
  ├─ VerificationExecutor: product-owned check runner (permission-gated: path-constrained read-only built-ins + shell only under explicit full access)
  ├─ ResultBuilder: deterministic Summary/Changes/Verification/Remaining
  ├─ LoopController: execute → collect → evaluate → continue/terminal
  ├─ LoopEvaluator: check facts vs requirement assessment (completion gate + check suggestion)
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
| G4 — semantics | Plan revisions, Vibe entries, Loop state machine, conditions-matched completion gate and terminal states | **Passed by `temporal-domain.mjs` + `loop-gate-impl.mjs`**: Plan reuse with two versions, Plan→Vibe finalize, Vibe accumulation + top Result, Loop new Round terminal; no-progress, same-error, 16-continuation budget, structured `[BLOCKED]`, wall-clock budget boundaries, evidence-complete terminals, and all TODO-5 counterexamples rejected (partial A+B, unrelated-file fact, behavioral unknown, typecheck-does-not-cover-tests, `Run:` proves only itself, stale-after-modify, same-size/same-mtime hash invalidation, deleted artifact, retest-clears-same-object vs unrelated-success-does-not, long-spec tail, heading requirement, fenced-code-block isolation, real wrong-content / directory-instead-of-file / missing-second-file / wrong-JSON-field integration, shell denial under workspace-write) |
| G5 — result trust | Evidence-backed Verification and truthful terminal reason | **Passed by `temporal-domain.mjs` + `loop-gate-impl.mjs` + `verify-permissions-impl.mjs` + installed-app probes**: a model claim with no collected evidence produces an empty Verification set; Verification lines come from product-executed checks with recorded facts (tool completion alone is not a pass); the `completed` reason lists actual req coverage with evidence IDs; a blocked/failed/budget terminal carries its real reason and is never rendered as success; denied checks surface as actionable Remaining lines with the real reason |
| G6 — desktop | Typecheck, build, startup, multiple windows, packaged install | Typecheck/build pass; multi-window and installed-app runtime verification are the remaining items (see `docs/v1-acceptance.md`) |

Passing a build is not acceptance of a gate that requires runtime behavior.

## Implementation notes

- **Evidence is collected, not asserted.** `EvidenceCollector` snapshots the real workspace (git status/diff for repos, bounded mtime walk otherwise) before and after each turn, distinguishing pre-existing user changes (`preexisting`) from this turn's contribution, and folds structured DSH tool-call facts into the bundle. Since TODO 5 every snapshot also records a bounded sha1 content hash (files ≤ 1 MB), so a same-size, same-mtime edit is detected as a change instead of being missed by `changedSinceFiles` or by validity stamps. `ResultBuilder` is deliberately deterministic: it can only emit a Verification line from a product-executed check whose recorded fact matched, so a model sentence like "all tests passed" can never fabricate one. If an execution produces no verification evidence, the Result says so rather than claiming success.
- **Check facts and requirement assessment are strictly separate layers (TODO 5).** The `VerificationExecutor` records `CheckFact`s (file exists as a regular file, content equals expected text by hash, JSON field equals expected value, command exited 0) — facts describe what was actually checked and observed, never which requirement they satisfy. `LoopEvaluator.assessItem` is the only place that maps facts onto requirement assessment: every requirement is parsed into objective conditions (`file` / `content` / `field` / `command` / `tests` / `typecheck` / `build`), and an item is `satisfied` only when **every** condition is covered by the latest valid, relevant fact of the matching kind. A generator-written `covers: [req-N]` no longer exists anywhere in the model. Requirements with no objective condition stay `unknown` (never satisfied by a guess); an unrelated passing check (even `npm test`) never covers a requirement it was not derived from; a `Run:` acceptance clause proves only its own command's exit.
- **Verification runs under the session permission, fail closed (TODO 5).** Every `VerificationRequest` carries `{ preset, workspacePath }` from the owning session. Built-in checks (file/content/field) are pure path-constrained read-only APIs: targets must resolve inside the canonical workspace (lexical escapes, other drives, UNC paths, `..`, and junction/symlink re-entry are resolved through realpath and rejected case-insensitively on Windows). Shell checks cannot be confined to the workspace on Windows, so they execute only under the explicit `danger-full-access` preset; under `read-only` / `workspace-write` — and always when the preset is missing — the executor refuses the check and records `outcome: 'denied'` with the real reason. Denials are never rendered as passes and never silently escalate the preset. Timeouts kill the whole verification process tree (`taskkill /PID <pid> /T /F` runs **before** the direct kill — once the parent is gone its tree is unresolvable and a grandchild would survive to write later), which a probe proves with a nested cmd that owns the late write.
- **Loop completion is a conditions-matched gate, never the model's claim.** `LoopEvaluator.decide` extracts every requirement line from the root spec (no truncation; fenced code blocks are never parsed as requirements or acceptance commands; a demand inside a Markdown heading is retained), and each item must be covered by currently-valid, relevant verification facts (validity compares run stamps — including content hashes — against the live file states and the turn in which a target last changed). Check suggestions are generated only for conditions that are not yet covered, so a repeated passing check can never count as loop progress. A failed check is cleared only by a later passing re-test of the **same check object** (same method, command, and targets). Completion additionally requires no pending/unknown item and no known counter-evidence: unresolved failed checks, unresolved DSH tool failures, permission denials, artifacts modified or deleted after their check. `cmd /c` invocations pass `windowsVerbatimArguments` so inner quotes survive Node's default re-quoting. The `completed` reason is composed from the actual coverage (`req-N (evidence-id)`), never a canned sentence. Remaining gaps and workspace issues become the next continuation prompt; the model is told it may start a reply with the structured `[BLOCKED]` marker only when genuinely blocked. Budgets yield `budget_exhausted`, repeated identical errors `failed`, and the marker `blocked`.
- **Plan/Vibe reuse, Loop isolation.** Plan and Vibe submissions reuse one open Round (Plan appends a version, Vibe appends an entry); switching mode, `End Round`, or the first Loop submit finalizes the open Round. Loop internal turns never appear as sidebar Rounds; each Loop submit creates exactly one terminal Round and one Result.
- **Crash honesty.** A Round that is `runtime_active` at startup is reconciled to `interrupted`, never `completed`. Terminal writes clear `runtime_active` in the same statement, and the engine tolerates an already-inactive runtime.
- **Draft race.** Draft writes bump a revision; after a submit, the store clears the draft only if it still matches the submitted revision, so edits made while running survive a restart.

## Known limitations / follow-ups

- The Loop evaluator is a deterministic conditions-matched evidence gate (every parsed objective condition covered by valid, relevant, passing facts; no pending/unknown; no counter-evidence), not a model-driven requirements evaluator. This is intentional for V1 trustworthiness. Natural-language requirements whose text yields no objective condition stay `unknown` by design instead of being guessed.
- Permission presets map to DSH's documented `DSH_PERMISSION_MODE`; a real-model probe (`dsh-permission-impl.mjs`) and the installed-app `readonly` scenario confirm writes are denied under `read-only` while `workspace-write` succeeds. The product's own verification executor enforces the same preset: on Windows there is no available sandbox for arbitrary commands, so shell verification is refused under `read-only` / `workspace-write` and only built-in read-only checks (existence, content, JSON field) run there — spec authors must phrase requirements so they are verifiable by built-in checks, or run the session with explicit full access. This is a deliberate fail-closed design decision, recorded with a real denial reason per refused check, not a silent capability gap.
- DSH's tool layer is intermittently unreliable on this machine: sampling shows the `write` tool failing occasionally (retried by the model) and the system `pwsh` (PowerShell 7) is not installed, while `cmd` is available. Public ACP does not transmit tool error text or exit codes, so the literal `0xC0000142`/`3221225794` from an earlier screenshot could not be confirmed at the tool layer. The product's verification therefore always runs through its own executor and records real facts, so DSH tool failures surface only as observed facts / known issues, never as passing evidence. Recovery of a failed DSH tool is recognized by a later `completed` call with the same title — public ACP exposes no inputs/outputs to match more narrowly.
- Legacy transcript reading remains unavailable by public interface; the placeholder is the V1 contract.
