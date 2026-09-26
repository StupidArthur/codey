import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { RunnerEvent } from '../../shared/contracts'
import type { ToolCallFact } from '../evidence/evidence'

/** A partial Runner event; the runtime stamps id/at when it forwards it. */
export type ProjectedEvent = Pick<RunnerEvent, 'kind' | 'message'>

/**
 * Projects one DSH turn's ACP updates into Runner events, the final assistant
 * text, and structured tool facts. Verification is NEVER derived here: a tool
 * title matching test/build, or a `status=completed` tool call, is not a check
 * that passed. Tool calls become display events plus `ToolCallFact`s (observed
 * facts only); verdicts come exclusively from the product's verification
 * executor, keyed by required-spec item, not by tool title.
 */
export class TurnProjector {
  private readonly events: ProjectedEvent[] = []
  private readonly toolFacts = new Map<string, ToolCallFact>()
  private assistant = ''
  private thoughtOpen = false

  handle(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.thoughtOpen = false
        if (update.content.type === 'text') this.assistant += update.content.text
        return
      case 'agent_thought_chunk':
        if (update.content.type === 'text' && !this.thoughtOpen) {
          this.thoughtOpen = true
          this.push('thinking', truncate(update.content.text))
        }
        return
      case 'tool_call': {
        this.thoughtOpen = false
        this.push('tool', truncate(update.title))
        const existing = this.toolFacts.get(update.toolCallId)
        this.toolFacts.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          turn: existing?.turn ?? 0,
          title: update.title || existing?.title || 'tool',
          kind: update.kind ?? 'other',
          status: 'pending',
          at: nowIso()
        })
        return
      }
      case 'tool_call_update': {
        this.thoughtOpen = false
        const label = update.title?.trim() || update.toolCallId
        if (update.status === 'failed') this.push('error', `${truncate(label)}: failed`)
        else if (update.status === 'completed') this.push('tool', `${truncate(label)}: completed`)
        const existing = this.toolFacts.get(update.toolCallId)
        if (existing) {
          this.toolFacts.set(update.toolCallId, {
            ...existing,
            title: update.title?.trim() || existing.title,
            kind: update.kind ?? existing.kind,
            status: update.status === 'completed' || update.status === 'failed' ? update.status : 'in_progress',
            at: nowIso()
          })
        }
        return
      }
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
    return facts
  }

  get assistantText(): string {
    return this.assistant
  }

  private push(kind: ProjectedEvent['kind'], message: string): void {
    this.events.push({ kind, message })
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}
