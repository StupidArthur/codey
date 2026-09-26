/**
 * Plan turns are guidance, not sandbox. The installed DSH (0.1.7-rc.2)
 * exposes no ACP session modes (probed: `session/new` returns no `modes` and
 * `session/set_mode` is unusable), so Plan behavior is produced by an
 * explicit, product-owned instruction prepended to the user's spec, executed
 * in the SAME DSH session so the following Vibe/Loop turns keep the full
 * context. The session permission preset continues to enforce what the model
 * can actually do; the guidance asks, it does not confine.
 *
 * The user's original spec is stored verbatim in the plan version; only the
 * prompt sent to the model carries the guidance.
 */
export function planGuidance(spec: string): string {
  return [
    'The user submits a requirement below. Respond with an implementation plan, not an implementation.',
    'Do not create, modify, or delete any file, and do not run build, test, or install commands.',
    'Structure the plan as:',
    '1. Goal — restate what the user wants in one or two sentences.',
    '2. Approach — the steps you would take, in order, each with the files or commands it touches.',
    '3. Affected files — the workspace paths you expect to create or change.',
    '4. Verification — how the finished work could be verified (tests, typecheck, build, or explicit file checks).',
    '5. Open questions — anything you would need from the user before implementing.',
    'If the requirement is too small for a plan, say so and describe the concrete change you would make instead.',
    '',
    '---',
    '',
    spec
  ].join('\n')
}
