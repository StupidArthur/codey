import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { RunnerEvent } from '../../shared/contracts'
import type { ToolCallFact } from '../evidence/evidence'

/** A partial Runner event; the runtime stamps id/at when it forwards it. */
export type ProjectedEvent = Pick<RunnerEvent, 'kind' | 'message'>

interface ToolDisplayState {
  toolCallId: string
  name?: string
  title?: string
  kind?: string
  status?: string
  rawInput?: unknown
  rawOutput?: unknown
  content?: unknown
  locations?: unknown
  startedAtMs: number
}

/**
 * Projects one DSH turn's ACP updates into Runner events, the final assistant
 * text, and structured tool facts. Verification is NEVER derived here: a tool
 * title matching test/build, or a `status=completed` tool call, is not a check
 * that passed. Tool calls become display events plus `ToolCallFact`s (observed
 * facts only); verdicts come exclusively from the product's verification
 * executor.
 */
export class TurnProjector {
  private readonly events: ProjectedEvent[] = []
  private readonly toolFacts = new Map<string, ToolCallFact>()
  private readonly toolDisplay = new Map<string, ToolDisplayState>()
  private assistant = ''
  private thoughtOpen = false

  handle(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.thoughtOpen = false
        if (update.content.type === 'text') this.assistant += update.content.text
        return

      case 'agent_thought_chunk':
        // ACP thought chunks are intentionally kept terse in the Runner. The
        // detailed diagnostic stream is persisted separately for performance
        // analysis; the UI should not turn into a chain-of-thought transcript.
        if (!this.thoughtOpen) {
          this.thoughtOpen = true
          this.push('thinking', 'Analyzing…')
        }
        return

      case 'tool_call': {
        this.thoughtOpen = false
        const state = mergeToolState(undefined, update)
        this.toolDisplay.set(update.toolCallId, state)
        this.push('tool', formatToolStart(state))

        const existing = this.toolFacts.get(update.toolCallId)
        this.toolFacts.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          turn: existing?.turn ?? 0,
          title: update.title || existing?.title || update.name || 'tool',
          kind: update.kind ?? 'other',
          status: 'pending',
          at: nowIso()
        })
        return
      }

      case 'tool_call_update': {
        this.thoughtOpen = false
        const state = mergeToolState(this.toolDisplay.get(update.toolCallId), update)
        this.toolDisplay.set(update.toolCallId, state)

        if (update.status === 'failed') this.push('error', formatToolFinish(state, true))
        else if (update.status === 'completed') this.push('tool', formatToolFinish(state, false))

        const existing = this.toolFacts.get(update.toolCallId)
        if (existing) {
          this.toolFacts.set(update.toolCallId, {
            ...existing,
            title: update.title?.trim() || update.name?.trim() || existing.title,
            kind: update.kind ?? existing.kind,
            status: update.status === 'completed' || update.status === 'failed' ? update.status : 'in_progress',
            at: nowIso()
          })
        }
        return
      }

      case 'usage_update': {
        const percent = update.size > 0 ? Math.round((update.used / update.size) * 100) : 0
        this.push('status', `context ${formatNumber(update.used)} / ${formatNumber(update.size)} tokens (${percent}%)`)
        return
      }

      case 'compaction_update': {
        const suffix = update.error ? ` · ${truncate(update.error, 180)}` : ''
        this.push(update.status === 'failed' ? 'error' : 'status', `compaction ${update.status}${suffix}`)
        return
      }

      case 'compaction_summary_chunk':
        // The raw summary is kept in the diagnostic log. A single status line
        // in the Runner is enough to make compaction visible without flooding.
        return

      case 'plan':
        this.thoughtOpen = false
        this.push('status', 'plan updated')
        return

      case 'plan_update':
      case 'plan_removed':
        this.thoughtOpen = false
        this.push('status', 'plan changed')
        return

      case 'current_mode_update':
        this.thoughtOpen = false
        this.push('status', `mode: ${update.currentModeId}`)
        return

      case 'config_option_update':
        this.thoughtOpen = false
        this.push('status', 'configuration updated')
        return

      default:
        return
    }
  }

  drain(): ProjectedEvent[] {
    return this.events.splice(0, this.events.length)
  }

  /** Returns and clears the structured tool facts for this turn (display-only, never verdicts). */
  drainToolFacts(): ToolCallFact[] {
    const facts = [...this.toolFacts.values()]
    this.toolFacts.clear()
    this.toolDisplay.clear()
    return facts
  }

  get assistantText(): string {
    return this.assistant
  }

  private push(kind: ProjectedEvent['kind'], message: string): void {
    this.events.push({ kind, message })
  }
}

function mergeToolState(previous: ToolDisplayState | undefined, update: unknown): ToolDisplayState {
  const value = asRecord(update)
  const id = stringValue(value.toolCallId) || previous?.toolCallId || 'tool'
  return {
    toolCallId: id,
    name: nullableString(value.name) ?? previous?.name,
    title: nullableString(value.title) ?? previous?.title,
    kind: nullableString(value.kind) ?? previous?.kind,
    status: nullableString(value.status) ?? previous?.status,
    rawInput: value.rawInput !== undefined ? value.rawInput : previous?.rawInput,
    rawOutput: value.rawOutput !== undefined ? value.rawOutput : previous?.rawOutput,
    content: value.content !== undefined ? value.content : previous?.content,
    locations: value.locations !== undefined ? value.locations : previous?.locations,
    startedAtMs: previous?.startedAtMs ?? Date.now()
  }
}

function formatToolStart(state: ToolDisplayState): string {
  const label = toolLabel(state)
  const input = summarizeInput(state.rawInput, state.locations)
  return input ? `${label}\n↳ ${input}` : label
}

function formatToolFinish(state: ToolDisplayState, failed: boolean): string {
  const label = toolLabel(state)
  const duration = Date.now() - state.startedAtMs
  const input = summarizeInput(state.rawInput, state.locations)
  const result = summarizeOutput(state.rawOutput, state.content)
  const status = failed ? 'failed' : 'completed'
  const details = [
    input ? `input: ${input}` : '',
    result ? `output: ${result}` : ''
  ].filter(Boolean)
  return details.length
    ? `${label} · ${status} · ${formatDuration(duration)}\n↳ ${details.join('\n↳ ')}`
    : `${label} · ${status} · ${formatDuration(duration)}`
}

function toolLabel(state: ToolDisplayState): string {
  const name = state.name?.trim()
  const title = state.title?.trim()
  if (name && title && name !== title) return `${name} — ${truncate(title, 140)}`
  return truncate(name || title || state.kind || state.toolCallId, 160)
}

function summarizeInput(rawInput: unknown, locations: unknown): string {
  const locationText = summarizeLocations(locations)
  if (rawInput === undefined || rawInput === null) return locationText
  const record = asRecordOrUndefined(rawInput)
  if (record) {
    const preferred = ['path', 'file', 'filePath', 'command', 'cmd', 'query', 'pattern', 'task', 'prompt', 'description']
    const parts: string[] = []
    for (const key of preferred) {
      if (!(key in record)) continue
      const text = compactValue(record[key], 220)
      if (text) parts.push(`${key}=${text}`)
      if (parts.length >= 2) break
    }
    if (parts.length > 0) return truncate([parts.join(' · '), locationText].filter(Boolean).join(' · '), 320)
  }
  return truncate([compactValue(rawInput, 280), locationText].filter(Boolean).join(' · '), 320)
}

function summarizeOutput(rawOutput: unknown, content: unknown): string {
  if (rawOutput !== undefined && rawOutput !== null) return outputShape(rawOutput)
  if (content !== undefined && content !== null) return outputShape(content)
  return ''
}

function outputShape(value: unknown): string {
  if (typeof value === 'string') {
    const chars = value.length
    const lines = value ? value.split(/\r?\n/).length : 0
    const first = value.replace(/\s+/g, ' ').trim()
    return truncate(`${formatNumber(chars)} chars · ${formatNumber(lines)} lines${first ? ` · ${first}` : ''}`, 260)
  }
  if (Array.isArray(value)) {
    const text = value.map(extractText).filter(Boolean).join(' ')
    return text
      ? truncate(`${value.length} blocks · ${text}`, 260)
      : `${value.length} blocks`
  }
  const serialized = compactValue(value, 240)
  return serialized ? truncate(serialized, 260) : ''
}

function summarizeLocations(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return ''
  const paths = value.map((item) => {
    const row = asRecordOrUndefined(item)
    return row ? stringValue(row.path) || stringValue(row.uri) : ''
  }).filter(Boolean)
  return paths.length ? `locations=${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}` : ''
}

function extractText(value: unknown): string {
  const row = asRecordOrUndefined(value)
  if (!row) return ''
  if (row.type === 'content') {
    const content = asRecordOrUndefined(row.content)
    return content && content.type === 'text' ? stringValue(content.text) : ''
  }
  if (row.type === 'diff') return stringValue(row.path)
  return ''
}

function compactValue(value: unknown, max: number): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return truncate(value.replace(/\s+/g, ' ').trim(), max)
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return truncate(String(value), max)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return asRecordOrUndefined(value) ?? {}
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nullableString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value)
}

function nowIso(): string {
  return new Date().toISOString()
}

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
