# Upstream report — SDK `sdk` profile cannot resume a persisted session

Status: **blocking** for any client that must continue an existing session.
Reported: 2026-09-25

Target versions (installed in the reproduction environment):

| package | version |
| --- | --- |
| `@deepseek-ai/dsh` | `0.1.7-rc.2` |
| `@deepseek-ai/dsh-sdk-client` | `0.1.7-rc.2` |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` | `0.1.7-rc.2` |
| `@deepseek-ai/dsh-agent` | `0.1.7-rc.2` |
| `@deepseek-ai/dsh-sdk-protocol` (resolved peer) | `0.1.0-rc.8` |

Environment: Windows, Node `v24.12.0`; provider `deepseek-official`, model `deepseek-v4-flash`, a valid `DEEPSEEK_API_KEY`.

Terminology used below: the probe is **one Node host process**; a `DeepSeekHarness` starts its own **`dsh --profile sdk` runtime subprocess**. “Resume after restart” means a second runtime subprocess (started by a second `DeepSeekHarness` in the same host process) reading the same DSH home.

## Summary

When a second SDK runtime subprocess opens the same DSH home and the client calls `DeepSeekHarness.session(existingId).run(...)`, the call rejects with a JSON-RPC error:

- name: `JsonRpcResponseError`
- code: `-32603`
- message: `session "<id>" already exists`

The SDK wire request map contains only `initialize`, `session/prompt`, and `shutdown`. The `sdk` profile server always routes a prompt through `ctx.agents.create(...)` and never `ctx.agents.resume(...)`. Because the SDK runtime keeps live sessions in an in-process map, a fresh runtime subprocess treats a persisted id as a new session and calls `create`. That call collides with the session already persisted at that id (persistence inferred from the collision; see Evidence provenance).

Effect: there is no public SDK path to continue an already-persisted session in a new runtime subprocess.

## Reproduction

```text
DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-p0.mjs
```

Observed (sanitized structured output; `status: "failed"`, exit code 1). Verbatim phase rows:

| phase | result | recorded fields |
| --- | --- | --- |
| `initialize` | passed | |
| `first-prompt` | passed | `responseCharacters: 55`, `idleObserved: true`, `assistantEvents: 1` |
| `sequential-prompt` | passed | `responseCharacters: 11`, `idleObserved: true`, `assistantEvents: 1` |
| `sequential-context-inherited` | passed | second prompt in the **same runtime subprocess** recalled the token |
| `first-close` | passed | `close()` resolved |
| `resume-after-restart` | **failed** | `name: "JsonRpcResponseError"`, `code: -32603`, `message: "session \"session-<id>\" already exists"` |
| `second-close` | passed | `close()` resolved |

`first-close`/`second-close` are reported `passed: true` only after `close()` actually resolves; a rejected `close()` records `passed: false` with the error fields and fails the run. The error fields are read from the thrown error (`JsonRpcResponseError.code` is `number | undefined`); `-32603` is what that run observed, not a hardcoded value. Error text is redacted for credential-like environment values and the probe's own memory token before flattening/truncation.

Exit codes: `0` all phases passed; `1` a phase failed — including a pre-model failure when no credential is present; `2` no credential and every phase that ran passed (model phases skipped).

A shorter diagnostic with per-phase isolation and the same close/error semantics is `scripts/probes/dsh-runtime-diag.mjs`:

```text
hasKey: true
subprocess1: ok
subprocess1-close: ok
subprocess2-resume: { ok: false, name: "JsonRpcResponseError", code: -32603, message: "session \"session-<id>\" already exists" }
subprocess2-close: ok
```

Minimal sequence (same host process, two runtime subprocesses):

1. Runtime subprocess 1: `new DeepSeekHarness({ profile:'sdk', dshHome, cwd, provider, model })`, `start()`, `session()` (mints `session-<uuid>`), `run("Remember this token: X …")`, `close()`.
2. Runtime subprocess 2: same `dshHome`/`cwd`, `start()`, `session(sameId).run("What token did I ask you to remember?")`.
   - Expected: the answer contains `X` (context restored).
   - Actual: the JSON-RPC error above.

## Root cause (public source)

Directly proven by the public source of the installed versions:

1. The wire surface has no resume request. `@deepseek-ai/dsh-sdk-protocol@0.1.0-rc.8`, `lib/types/types.d.ts`, `HarnessSdkRequestMap` lists exactly:
   ```ts
   'initialize' | 'session/prompt' | 'shutdown'
   ```
2. The `sdk` profile server always creates. `@deepseek-ai/dsh-sdk-jsonrpc-server@0.1.7-rc.2`, `lib/index.js`, class `HarnessSdkJsonRpcServer`:
   - `handleRequest` switches only on `initialize`, `session/prompt`, `shutdown`;
   - `prompt` → `getOrCreateSession(sessionId)`;
   - `getOrCreateSession` consults the in-process `this.sessions` map only, then calls `createSession`;
   - `createSession` calls `this.ctx.agents.create({ sessionId, meta: { cwd: this.cwd }, agentOptions })`. There is no `agents.resume` call.
3. A resume path does exist one layer down. `@deepseek-ai/dsh-agent@0.1.7-rc.2`, `lib/index.js`, the `agents` service (`AgentRegistry`) defines both `create(options)` and `resume(options)`—the latter documented as “Load a persisted session and resume an agent on it”.

Inferred from behavior (not directly inspected): the colliding id is present in the persisted session store, which is why `agents.create` rejects. We did not read DSH private storage or JSONL; we infer persistence from the collision message and from the ACP behaviour below.

## Comparison: the public ACP profile does resume

The shipped ACP profile exposes `session/resume` and restores context across runtime subprocesses. The ACP probe is also one Node host process starting two `dsh --profile acp` subprocesses in sequence against the same DSH home:

```text
DEEPSEEK_API_KEY=... node scripts/probes/dsh-acp-resume.mjs
```
```json
{
  "create": { "stopReason": "end_turn", "chunkChars": 44 },
  "resume": { "ok": true },
  "resumeContext": { "stopReason": "end_turn", "chunkChars": 19, "hasToken": true }
}
```

So resume is supported by the persistence/agent layer and by the ACP transport; only the **SDK transport** lacks the operation. `session/list(cwd)` from the ACP profile also returns persisted sessions (verified in `scripts/probes/dsh-acp-discovery.mjs`, including cursor pagination).

## Evidence provenance

- **Proven by the probes above**: the failure phase, `JsonRpcResponseError`, code `-32603`, its message, and that `close()` resolved for both runtime subprocesses.
- **Proven by public source**: the SDK request map has only three methods; the `sdk` server calls `agents.create` and never `agents.resume`; `agents.resume` exists.
- **Inferred**: the exact persistence mechanism that makes the id “already exist”. Not inspected.
- **Not tested / not claimed**: cross-profile resume equivalence (an id created by the `acp` profile being resumed by the `sdk` profile). This report does not claim that is verified.

## Questions / requests

1. Is resuming a persisted session intentionally unsupported in the SDK wire for `0.1.7-rc.2`, or is this a gap? If supported, what is the correct public call?
2. If unsupported: please add a resume request to the SDK wire, or make `session/prompt` re-attach (via `agents.resume`) when the id already exists in persistence, so `DeepSeekHarness.session(existingId).run(...)` continues the existing context in a new runtime subprocess.
3. If neither is planned for this version: is routing existing-session execution through the public ACP `session/resume` + `session/prompt` the recommended interim path, while the SDK is used only for newly created sessions?
4. Can you confirm whether an id created under one profile (e.g. `acp`) is fully equivalent for resume under another (`sdk`)? Both profiles share the single DSH home (`$DSH_HOME` → `~/.dsh`), but we have not been able to test cross-profile resume end to end.

We are not reading DSH private storage and are not parsing JSONL; we would like to stay on a public interface.
