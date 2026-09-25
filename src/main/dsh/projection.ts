import type { SessionUpdate } from '@agentclientprotocol/sdk'
import type { RunnerEvent } from '../../shared/contracts'

/** A partial Runner event; the runtime stamps id/at when it forwards it. */
export type ProjectedEvent = Pick<RunnerEvent, 'kind' | 'message'>

const VERIFICATION = /test|vitest|jest|typecheck|tsc|build|lint|compile|tsc --noemit/i

/**
 * Projects one DSH turn's ACP updates into Runner events and the final
 * assistant text. Only verified update kinds are projected:
 * - `agent_thought_chunk` → thinking (a real reasoning event);
 * - `tool_call` / `tool_call_update` → tool, or verification for known checks;
 * - `plan` / mode / config changes → status;
 * - `agent_message_chunk` → assistant text only (never labelled thinking).
 */
export class TurnProjector {
  private readonly events: ProjectedEvent[] = []
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
      case 'tool_call':
        this.thoughtOpen = false
        this.push('tool', truncate(update.title))
        return
      case 'tool_call_update': {
        this.thoughtOpen = false
        const label = update.title?.trim() || update.toolCallId
        if (update.status === 'failed') this.push('error', `${truncate(label)}: failed`)
        else if (update.status === 'completed') {
          this.push(VERIFICATION.test(label) ? 'verification' : 'tool', `${truncate(label)}: completed`)
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

  get assistantText(): string {
    return this.assistant
  }

  private push(kind: ProjectedEvent['kind'], message: string): void {
    this.events.push({ kind, message })
  }
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}
