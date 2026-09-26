/**
 * OpenCode's native `plan` primary agent supplies the read-only execution
 * boundary. This product guidance only shapes the plan artifact returned to
 * Codey; the same OpenCode Session is reused by later Vibe/Loop turns.
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
