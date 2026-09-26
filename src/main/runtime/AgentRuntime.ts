import type { ToolCallFact } from '../evidence/evidence'

export const TURN_DEADLINE_MESSAGE = 'Agent turn deadline exceeded'
export const TURN_CANCELLED_MESSAGE = 'Agent turn cancelled by user'

export type RuntimeAgent = 'plan' | 'build'

export interface RuntimePromptOptions {
  timeoutMs?: number
  agent?: RuntimeAgent
}

/** Backend-neutral contract consumed by Plan/Vibe/Loop. */
export interface AgentRuntime {
  start(sessionId?: string): Promise<{ sessionId: string }>
  prompt(spec: string, options?: RuntimePromptOptions): Promise<{ text: string }>
  cancelTurn(): Promise<boolean>
  close(): Promise<void>
  takeToolFacts(): ToolCallFact[]
}
