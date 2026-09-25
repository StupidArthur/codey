# Temporal Workspace — Architecture Review

Date: 2026-09-25  
Status: **scaffold accepted; product implementation not accepted**

## Architectural ownership

The architect owns decisions, contracts, task boundaries, risk resolution, and acceptance. Implementing feature logic belongs to assigned engineering agents. The current `WindowController` was written directly during scaffolding and is provisional; it must not be treated as the approved domain architecture.

## Process and data boundaries

```text
React Renderer
  │ typed, narrow API
Preload / IPC
  │
Electron Main
  ├─ WindowManager: one window ↔ one product session
  ├─ SessionService: DSH identity, discovery, resume, exclusive ownership
  ├─ RoundEngine: Plan/Vibe/Loop boundaries and durable transitions
  ├─ DshRuntimeAdapter: official SDK and bundled runtime lifecycle
  ├─ EvidenceCollector + ResultBuilder: facts and result projection
  ├─ ProductStore: SQLite product projection only
  └─ CredentialVault: OS-protected credential storage
```

DSH is authoritative for conversation, execution, and model context. SQLite is authoritative for Temporal metadata, draft revisions, Round structure, and result documents. The renderer never reads the filesystem or starts DSH directly. Every IPC request is bound to its sending window.

## Decisions already fixed

1. Windows is the first release target. The installer includes version-matched DSH and SDK packages.
2. Model and credential configuration lives in this product; secrets are outside SQLite.
3. One window owns one Session. Exclusive ownership must hold across **processes**, not only within one Electron main process.
4. Loop defaults: 16 internal continuations, two hours, three consecutive no-progress cycles, two same-error retries. Completion requires task-relevant evidence and no known required gap.
5. Legacy DSH history is read-only and inherited. Temporal Round 1 starts with the first submission through this product, on the existing DSH Session.
6. The exact DSH/SDK pair is currently `0.1.7-rc.2`, the newest published `next` version checked on 2026-09-25. Version changes require repeating the P0 contract tests.

## Acceptance gates

| Gate | Required evidence | Current result |
| --- | --- | --- |
| G0 — package closure | Reproducible install of matched DSH + SDK | Passed locally with pinned lockfile |
| G1 — runtime | Initialize, first prompt, sequential prompt, resume, notifications, close | **Partial** (2026-09-25): initialize, first prompt, sequential prompt with inherited context, notifications and close passed with a real credential; **cross-process resume fails** because the `sdk` profile server only calls `agents.create` and never `agents.resume` (`session "<id>" already exists`). Public ACP `session/resume` does inherit context across processes |
| G2 — discovery/history | Public API lists sessions by canonical cwd and reads legacy history | **Partial** (2026-09-25): ACP `session/list(cwd)` adapter implemented and verified for isolation/pagination; legacy history read remains unavailable by public API and is shown as an explicit read-only placeholder |
| G3 — persistence | Migration, draft revision race, restart reconciliation | Basic SQLite smoke passed; restart reconciliation unverified |
| G4 — semantics | Plan revisions, Vibe entries, Loop budget/terminal states | Not implemented |
| G5 — result trust | Evidence-backed Verification and truthful terminal reason | Not implemented |
| G6 — desktop | Typecheck, build, startup, multiple windows, packaged install | Typecheck/build/startup passed; multi-window/package unverified |

Passing a build is not acceptance of a gate that requires runtime behavior.

## Provisional implementation issues

- `WindowController` currently combines IPC-facing orchestration, Round transitions, runtime ownership, and result text assembly. Engineering should split these along the boundaries above before adding Loop.
- In-memory session locks protect windows in one main process but do not meet the cross-process exclusivity decision.
- The current store now contains provisional tables for Plan revisions, Vibe entries, evidence, results, and session leases; their integration and restart behavior are not yet accepted.
- The renderer now uses CodeMirror 6; visual and end-to-end behavior is not yet accepted.
- Legacy Session discovery now uses public ACP `session/list(cwd)` (`SessionDiscovery`) and merges with ProductStore records; legacy history remains unreadable and must not be simulated from private DSH files or inferred from Temporal's own SQLite records.
- The current Loop action explicitly fails. It must remain unavailable until the controller and evidence gate are accepted.

## Engineering assignments and acceptance ownership

1. **Runtime integration agent:** finish G1 and G2 with runnable probes and captured protocol evidence. Propose a supported public history route or report the missing upstream capability. Do not add private-file parsing.
2. **Domain/persistence agent:** implement durable Plan/Vibe/Loop/Result schema, transactional state transitions, draft race behavior, crash reconciliation, and cross-process Session lock. Provide focused tests for those invariants.
3. **Renderer agent:** replace the editor with CodeMirror 6, bind History only to real read-only data, and verify startup/workspace/mode/runner states against the prototypes.
4. **Architect acceptance:** review each gate against evidence, reject unsupported completion claims, and defer release packaging until G1–G6 pass.

The first release slice remains a real `choose workspace → new session → submit → observe → result → reopen` path. G1 must pass before calling that slice complete; G2 is required for the legacy Session commitment.
