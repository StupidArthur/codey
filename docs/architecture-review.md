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
| G4 ? semantics | Natural-language Plan/Vibe/Loop, budgets, evidence validity | TODO 7: temporal-domain and loop-decision-gate cover model decisions, nonce/input binding, whole-round Result and truthful terminal states; final installed-app evidence is in docs/v1-acceptance.md |
| G5 ? result trust | Collected facts, explicit provenance and truthful terminal reason | TODO 7: empty verification is explicitly stated; stale passes are historical; sandbox reports identify artifact/input validation; model prose cannot fabricate product verification |
| G6 ? desktop | Typecheck, build, Windows install and application restart | Final TODO 7 commands, installed scenarios and screenshots are recorded in docs/v1-acceptance.md |

Passing a build is not acceptance of a gate that requires runtime behavior.

## Implementation notes

- **Evidence is collected, not asserted.** `EvidenceCollector` snapshots the real workspace (git status/diff for repos, bounded mtime walk otherwise) before and after each turn, distinguishing pre-existing user changes (`preexisting`) from this turn's contribution, and folds structured DSH tool-call facts into the bundle. Since TODO 5 every snapshot also records a bounded sha1 content hash (files ≤ 1 MB), so a same-size, same-mtime edit is detected as a change instead of being missed by `changedSinceFiles` or by validity stamps. `ResultBuilder` is deliberately deterministic: it can only emit a Verification line from a product-executed check whose recorded fact matched, so a model sentence like "all tests passed" can never fabricate one. If an execution produces no verification evidence, the Result says so rather than claiming success.
- **Facts and semantic assessment are separate (TODO 6/7).** RequiredSpec extracts optional objective hints; it is not the semantic completion authority. The model assesses the complete natural-language Spec in a structured temporal-decision. The product validates cited evidence, current input snapshots, known contradictions and budgets. Unknown parsed hints do not independently veto honest model-assessed completion.
- **Verification runs under the session permission, fail closed (TODO 5).** Every `VerificationRequest` carries `{ preset, workspacePath }` from the owning session. Built-in checks (file/content/field) are pure path-constrained read-only APIs: targets must resolve inside the canonical workspace (lexical escapes, other drives, UNC paths, `..`, and junction/symlink re-entry are resolved through realpath and rejected case-insensitively on Windows). Shell checks cannot be confined to the workspace on Windows, so they execute only under the explicit `danger-full-access` preset; under `read-only` / `workspace-write` — and always when the preset is missing — the executor refuses the check and records `outcome: 'denied'` with the real reason. Denials are never rendered as passes and never silently escalate the preset. Timeouts kill the whole verification process tree (`taskkill /PID <pid> /T /F` runs **before** the direct kill — once the parent is gone its tree is unresolvable and a grandchild would survive to write later), which a probe proves with a nested cmd that owns the late write.
- **Loop completion combines model assessment with product validation.** A completed decision requires nonempty met coverage, no declared remaining items, valid cited evidence and no known counter-evidence. When runnable checks exist, at least one currently valid passing verification must be cited; non-code tasks without checks may cite product-observed workspace artifacts. Sandbox requests have unique ids and input fingerprints. Changed, added or deleted collected inputs invalidate their results; a new check of the same stable check object supersedes old results. Logs and wrappers are excluded from task progress and input fingerprints. Semantic relevance is assessed by the model, not proven by a Markdown parser.
- **Plan/Vibe reuse, Loop isolation.** Plan and Vibe submissions reuse one open Round (Plan appends a version, Vibe appends an entry); switching mode, `End Round`, or the first Loop submit finalizes the open Round. Loop internal turns never appear as sidebar Rounds; each Loop submit creates exactly one terminal Round and one Result.
- **Crash honesty.** A Round that is `runtime_active` at startup is reconciled to `interrupted`, never `completed`. Terminal writes clear `runtime_active` in the same statement, and the engine tolerates an already-inactive runtime.
- **Draft race.** Draft writes bump a revision; after a submit, the store clears the draft only if it still matches the submitted revision, so edits made while running survive a restart.

## Known limitations / follow-ups

- Natural-language coverage and semantic relevance remain model-assessed. Product validation checks observable evidence and contradictions; it does not formally prove arbitrary task semantics. This is the frozen V1 boundary.
- Permission presets apply to both DSH and product verification. Product shell execution requires explicit danger-full-access; read-only supports confined builtin reads. Under workspace-write, tests/typecheck/build use product-generated nonce wrappers executed by DSH in its sandbox, then product verification reads matching result artifacts and checks their input fingerprint. This requires no automatic permission escalation. The UI labels these as DSH sandbox reports, not independently observed child-process exits.
- **Windows GUI runtime console (TODO 7).** A real installed-app check reproduced STATUS_DLL_INIT_FAILED (3221225794 / 0xC0000142) through the public ACL sandbox API in an Electron Node GUI child without a console. The same API command returned exit 0 after allocating a hidden console. WindowsRuntimeHost supplies a runtime-scoped NODE_OPTIONS preload for the Windows Electron runtime and its GUI runner descendants, preserving the inherited pipe handles and unchanged CLI/runner argv. Ordinary project node.exe processes skip the initialization. The ten-check windows-runtime-console probe verifies argv, bidirectional pipes, hidden console, workspace writes and denied outside writes. No DSH private storage, token policy, permission preset or dependency implementation is modified. Koffi 3.3.1 is declared directly (already present transitively in the pinned DSH distribution).
- Legacy transcript reading remains unavailable by public interface; the placeholder is the V1 contract.

## Frozen V1 closure (TODO 7)

Verification results are bound to request-specific artifact paths and a content-first fingerprint of collected project inputs. Fingerprints exclude temporal-verify, dependencies, Git metadata and declared build-output directories; collection remains bounded (depth 3, at most 200 files / 4000 visited entries, hashes up to 1 MB). This is evidence within the collected scope, not a proof of all external dependencies. Request ids prevent stale artifact reuse, not agent forgery: sandbox reports remain agent-writable and are explicitly attributed as such.

Result summaries deterministically include actual outputs across Vibe requests, the final Plan version, or the Loop output and terminal. They do not invoke the model again, run tools or create a new Round. No verification is explicitly stated, and request transport completion is not functional acceptance. Historical Result projections remain persisted without reconstructing legacy DSH transcripts.

Final command results and installer evidence are in docs/v1-acceptance.md, TODO 7 closure section. Once its frozen gates pass, V1 development is closed; optional improvements require separate user authorization.
