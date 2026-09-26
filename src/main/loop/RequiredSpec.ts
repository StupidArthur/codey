/**
 * One objective, machine-checkable acceptance condition parsed from a
 * requirement. Conditions are facts a check must establish; they are separate
 * from the item status, which the evaluator derives from real check facts.
 */
export interface RequirementCondition {
  kind: 'file' | 'content' | 'field' | 'command' | 'tests' | 'typecheck' | 'build'
  /** file/content/field: workspace-relative target path. */
  target?: string
  /** content: expected text; field: expected value; command: the command line. */
  expected?: string
  /** field: the JSON key (dot path supported). */
  key?: string
}

export interface RequiredItem {
  id: string
  /** The original spec text for this requirement, never truncated. */
  original: string
  line: number
  /** Objective acceptance conditions parsed from the requirement text. */
  conditions: RequirementCondition[]
  /** True when no objective check method could be parsed (stays unknown). */
  subjective: boolean
  status: 'satisfied' | 'pending' | 'unknown'
  evidenceIds: string[]
  /** Which objective conditions are not yet covered (set by the evaluator). */
  uncovered?: string[]
  note?: string
}

const HEADING = /^#{1,6}\s/
const BULLET = /^[ \t]*[-*+][ \t]+/
const NUMBERED = /^[ \t]*\d+[.)][ \t]+/
const FENCE = /^[ \t]*(?:```|~~~)/
const ACCEPTANCE = /^(?:run|verify|check|exec|execute|运行|验证|执行|检查)\s*[:：]?\s+(.+)$/i

const PATH = /(?:[A-Za-z0-9_./\\-]+\.(?:ts|js|tsx|jsx|mjs|cjs|json|md|txt|py|rs|go|sh|ps1|html|css|yaml|yml|toml|sql|ini|xml|csv|cfg|env))/g
const CREATE = /\bcreat\w*|\badds?\b|\bwrite\b|\bgenerate\b|创建|新建|添加|新增|生成|写出|写入/i
const TEST = /\btests?\b|\bspecs?\b|测试|单测/i
const TYPECHECK = /typecheck|\btsc\b|类型检查/i
const BUILD = /\bbuild\b|构建|编译/i

/** English content expectations, in priority order (first match wins). */
const CONTENT_EN: RegExp[] = [
  /(?:entire|whole|full)\s+contents?\s+(?:must|should|shall)?\s*(?:be|are|is|equal(?:s)?(?:\s+to)?)\s*(?:exactly)?(?:\s+the\s+single\s+line)?\s*[:：]?\s*(.+)/i,
  /contents?\s+(?:must|should|shall)\s+(?:be|equal(?:\s+to)?)\s*(?:exactly)?\s*[:：]?\s*(.+)/i,
  /contents?\s+(?:are|is)\s+exactly(?:\s+the\s+single\s+line)?\s*[:：]?\s*(.+)/i,
  /with\s+(?:the\s+)?contents?\s*(?:exactly)?\s*[:：]?\s*(.+)/i,
  /containing\s+(?:exactly\s+)?[:：]?\s*(.+)/i
]
/** Chinese content expectations; the be-verb or the must-word is required. */
const CONTENT_ZH: RegExp[] = [
  /内容(?:必须|应|应当|需要|得)\s*(?:为|是|等于|恰好是|恰好为)?\s*[:：]?\s*(.+)/,
  /内容\s*(?:为|是|等于|恰好是|恰好为)\s*[:：]?\s*(.+)/
]

const FIELD = /(?:\bfield\b|字段)\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*(?:=|＝|:|：|is|should\s+be|must\s+be|equals|为|是|等于)\s*([^\s，。;；,]+)/i

/**
 * Splits a root Spec into required items without truncation: every non-empty
 * line becomes (part of) a clause with a stable id and its exact original
 * text. Bullets and numbered items start new clauses; indented continuation
 * lines fold into the preceding clause; headings are kept as requirement
 * clauses (a trailing requirement in a long spec is therefore always
 * retained, and a demand inside a heading is never silently dropped). Lines
 * inside fenced code blocks are ignored — they are illustrations, not
 * requirements, and must never be misparsed as acceptance commands.
 *
 * Each clause is parsed into objective conditions (`file`, `content`,
 * `field`, `command`, `tests`, …). A clause whose text yields no objective
 * condition is kept as a subjective item: the evaluator reports it as
 * `unknown` instead of guessing that some unrelated file proves it.
 */
export function extractRequirements(spec: string): RequiredItem[] {
  const lines = spec.split('\n')
  const items: RequiredItem[] = []
  let current: { original: string[]; line: number; heading: boolean } | null = null
  let inFence = false

  const flush = (): void => {
    if (!current) return
    const original = current.original.join('\n').trim()
    if (original) {
      const item = buildItem(original, current.line, items.length + 1)
      // A heading that parses to no objective condition is structure, not a
      // requirement; prose without one is kept as a subjective requirement.
      if (item && (!current.heading || item.conditions.length > 0)) {
        items.push(item)
      }
    }
    current = null
  }

  lines.forEach((raw, index) => {
    const line = raw.trimEnd()
    if (FENCE.test(line.trim())) {
      inFence = !inFence
      return
    }
    if (inFence) return
    if (!line.trim()) return
    const heading = HEADING.test(line)
    if (heading || BULLET.test(line) || NUMBERED.test(line) || !/^[ \t]/.test(line)) {
      flush()
      current = { original: [line.trim()], line: index + 1, heading }
      return
    }
    // Indented continuation folds into the open clause.
    if (current) current.original.push(line.trim())
  })
  flush()
  return items
}

function buildItem(original: string, line: number, index: number): RequiredItem | null {
  const conditions: RequirementCondition[] = []

  // An explicit `Run:/Verify:` line proves only that command's own result; it
  // is a verification instruction, never a claim about neighbouring demands.
  const acceptance = extractAcceptance(original)
  if (acceptance) {
    conditions.push({ kind: 'command', expected: acceptance })
  } else {
    const { paths } = mentionPaths(original)

    const content = extractContent(original)
    if (content && paths.length > 0) {
      conditions.push({ kind: 'content', target: paths[0], expected: content.value })
    }
    const field = FIELD.exec(original)
    if (field && paths.length > 0) {
      conditions.push({ kind: 'field', target: paths[0], key: field[1], expected: cleanValue(field[2]) })
    }
    // A file-existence condition is only derived from an explicit creation
    // demand: "fix src/x.ts" must never be satisfied by the file existing.
    if (CREATE.test(original)) {
      for (const path of paths) conditions.push({ kind: 'file', target: path })
    }
    if (TEST.test(original)) conditions.push({ kind: 'tests' })
    if (TYPECHECK.test(original)) conditions.push({ kind: 'typecheck' })
    if (BUILD.test(original)) conditions.push({ kind: 'build' })
  }

  return {
    id: `req-${index}`,
    original,
    line,
    conditions,
    subjective: conditions.length === 0,
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

interface ContentMatch {
  value: string
  matched: string
}

function extractContent(text: string): ContentMatch | undefined {
  for (const pattern of [...CONTENT_EN, ...CONTENT_ZH]) {
    const match = pattern.exec(text)
    if (match && match[1]) {
      const value = cleanValue(match[1])
      if (value) return { value, matched: match[0] }
    }
  }
  return undefined
}

/** Strip paired quotes; otherwise strip one run of trailing sentence punctuation. */
function cleanValue(raw: string): string {
  const trimmed = raw.trim()
  const quote = trimmed.match(/^(["'`])(.*)\1$/s)
  if (quote) return quote[2]
  return trimmed.replace(/[.。!！?？]+$/, '').trim()
}

/** All file paths mentioned in a requirement, with content/field values removed
 *  from the scan text so a literal like "contents are exactly: NOTES.md" is not
 *  mistaken for a second required file. */
export function mentionPaths(original: string): { paths: string[]; scanText: string } {
  let scanText = original
  const field = FIELD.exec(original)
  if (field) scanText = scanText.replace(field[0], ' ')
  for (const pattern of [...CONTENT_EN, ...CONTENT_ZH]) {
    const match = pattern.exec(scanText)
    if (match && match[1]) {
      const value = cleanValue(match[1])
      if (value) scanText = scanText.replace(match[0], ' ')
    }
  }
  const paths: string[] = []
  for (const match of scanText.matchAll(PATH)) {
    const path = match[0].replace(/\\/g, '/').replace(/^[./]+/, '')
    if (path && !paths.includes(path)) paths.push(path)
  }
  return { paths, scanText }
}
