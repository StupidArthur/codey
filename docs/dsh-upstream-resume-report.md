# Upstream report — SDK `sdk` profile cannot resume a persisted session

Status: **blocking** for any client that must continue an existing session.
Reported: 2026-09-25
Target versions: `@deepseek-ai/dsh@0.1.7-rc.2`, `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2`
Environment: Windows, Node `v24.12.0`; provider `deepseek-official`, model `deepseek-v4-flash`, valid `DEEPSEEK_API_KEY`.

## Summary

After the SDK runtime subprocess is closed and a **new process** opens the same DSH home, `DeepSeekHarness.session(existingId).run(...)` fails with:

```
JsonRpcResponseError: session "session-<id>" already exists
code: -32603
```

The stored session is found (that is why `create` collides), but the runtime never re-attaches to it. The SDK wire exposes only `initialize`, `session/prompt`, and `shutdown`; the `sdk` profile server only calls `ctx.agents.create(...)` and never `ctx.agents.resume(...)`. As a result there is no public way, through the SDK, to continue a persisted session across process restarts.

This blocks:

- resuming a session after an application restart;
- continuing a session that was originally created by another profile (for example the public ACP profile).

## Reproduction

Probe in this repository (prints only phase status, ids, event kinds and counts — no content or credentials):

```text
DEEPSEEK_API_KEY=... node scripts/probes/dsh-runtime-p0.mjs
```

Observed (structured output, `status: "failed"`, exit code 1):

| phase | result | notes |
| --- | --- | --- |
| `initialize` | passed | |
| `first-prompt` | passed | assistant event + idle observed |
| `sequential-prompt` | passed | second prompt in the **same** process inherits the first context |
| `resume-after-restart` | **failed** | `session "<id>" already exists` |
| `first-close` | passed | subprocess reaped |

Minimal sequence:

1. Process A: `new DeepSeekHarness({ profile:'sdk', dshHome, cwd, provider, model })`, `start()`, `session()` (mints `session-<uuid>`), `run("Remember this token: X …")`, `close()`.
2. Process B: same `dshHome`/`cwd`, `start()`, `session(sameId).run("What token did I ask you to remember?")`.
   - Expected: the answer contains `X` (context restored).
   - Actual: JSON-RPC error `session "<id>" already exists`.

A shorter diagnostic with per-phase isolation is in `scripts/probes/dsh-runtime-diag.mjs`.

## Root cause (public code)

In `@deepseek-ai/dsh-sdk-jsonrpc-server` (`lib/index.js`), the request handler is:

```js
async prompt(params) {
  const rec = await this.getOrCreateSession(params.sessionId);
  ...
}
async getOrCreateSession(sessionId) {
  const existing = this.sessions.get(sessionId);   // in-memory only
  if (existing) return existing;
  ...
  return this.createSession(sessionId);
}
async createSession(sessionId) {
  const rec = { handle: await this.ctx.agents.create({
    sessionId: brandString(sessionId),
    meta: { cwd: this.cwd },
    agentOptions: { ... }
  }) };
  this.sessions.set(sessionId, rec);
  return rec;
}
```

`this.sessions` is an in-process map. On a fresh process it is empty, so a persisted id always goes to `agents.create`. `agents.create` throws `session "<id>" already exists` when the id is already present in the session store. `ctx.agents` does expose a separate `resume(options)` entry point (see `@deepseek-ai/dsh-agent`, `AgentsService.resume`), but the SDK server never calls it, and the SDK wire has no resume request.

`handleRequest` accepts only:

```js
case "initialize": ...
case "session/prompt": ...
case "shutdown": ...
```

## Comparison: the public ACP profile does resume

The shipped ACP profile exposes `session/resume`, and it restores context across processes.

Probe: `DEEPSEEK_API_KEY=... node scripts/probes/dsh-acp-resume.mjs`

```json
{
  "create": { "stopReason": "end_turn", "chunkChars": 44 },
  "resume": { "ok": true },
  "resumeContext": { "stopReason": "end_turn", "chunkChars": 19, "hasToken": true }
}
```

So the persistence layer supports it; only the **SDK transport** lacks the operation. `session/list(cwd)` from the same ACP profile also returns persisted, resumable sessions (verified separately in `scripts/probes/dsh-acp-discovery.mjs`, including cursor pagination).

## Questions / requests

1. Is resuming a persisted session intentionally unsupported in the SDK wire for `0.1.7-rc.2`, or is this a gap? If supported, what is the correct public call?
2. If unsupported: please add a resume request to the SDK wire (or make `session/prompt` re-attach when the id already exists in persistence, using `agents.resume`) so that `DeepSeekHarness.session(existingId).run(...)` continues the existing context in a new process.
3. If neither is planned for this version: is routing existing-session execution through the public ACP `session/resume` + `session/prompt` the recommended interim path, while the SDK is used only for newly created sessions?
4. Can you confirm whether an id created under one profile (e.g. `acp`) is fully equivalent for resume under another (`sdk`) once the resume gap is closed? Both profiles share the single DSH home (`$DSH_HOME` → `~/.dsh`), but we have not been able to test cross-profile resume end to end.

We are not reading DSH private storage and are not parsing JSONL; we would like to stay on a public interface.
