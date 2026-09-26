export interface RequiredItem {
  id: string
  /** The original spec text for this requirement, never truncated. */
  original: string
  line: number
  /** An explicit check command when the requirement says "Run:/Verify:/Check: …". */
  acceptance?: string
  status: 'satisfied' | 'pending' | 'unknown'
  evidenceIds: string[]
  note?: string
}

const HEADING = /^#{1,6}\s/
const BULLET = /^[ \t]*[-*+][ \t]+/
const NUMBERED = /^[ \t]*\d+[.)][ \t]+/
const ACCEPTANCE = /^(?:run|verify|check|exec|execute|运行|验证|执行|检查)\s*[:：]?\s+(.+)$/i

/**
 * Splits a root Spec into required items without truncation: every non-empty,
 * non-heading line becomes (part of) a clause with a stable id and its exact
 * original text. Bullets and numbered items start new clauses; indented
 * continuation lines are folded into the preceding clause. A trailing
 * requirement at the end of a long spec is therefore always retained.
 */
export function extractRequirements(spec: string): RequiredItem[] {
  const lines = spec.split('\n')
  const items: RequiredItem[] = []
  let current: { original: string[]; line: number } | null = null

  const flush = (): void => {
    if (!current) return
    const original = current.original.join('\n').trim()
    if (original) items.push(buildItem(original, current.line, items.length + 1))
    current = null
  }

  lines.forEach((raw, index) => {
    const line = raw.trimEnd()
    if (!line.trim()) return
    if (HEADING.test(line)) return
    if (BULLET.test(line) || NUMBERED.test(line) || !/^[ \t]/.test(line)) {
      flush()
      current = { original: [line.trim()], line: index + 1 }
      return
    }
    // Indented continuation folds into the open clause.
    if (current) current.original.push(line.trim())
  })
  flush()
  return items
}

function buildItem(original: string, line: number, index: number): RequiredItem {
  const acceptance = extractAcceptance(original)
  return {
    id: `req-${index}`,
    original,
    line,
    ...(acceptance ? { acceptance } : {}),
    status: 'pending',
    evidenceIds: []
  }
}

function extractAcceptance(original: string): string | undefined {
  for (const line of original.split('\n')) {
    const match = ACCEPTANCE.exec(line.trim())
    if (match && match[1].trim()) return match[1].trim()
  }
  return undefined
}

/** A file path mentioned in a requirement (e.g. `src/answer.txt`), if any. */
export function mentionPath(original: string): string | undefined {
  const match = original.match(/(?:[A-Za-z0-9_./\\-]+\.(?:ts|js|tsx|jsx|mjs|cjs|json|md|txt|py|rs|go|sh|ps1|html|css|yaml|yml|toml|sql))/)
  return match?.[0]?.replace(/\\/g, '/')
}
