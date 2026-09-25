/**
 * The DSH SDK wire protocol currently exposes initialize, session/prompt and
 * shutdown. It has no list or history read requests. Keep these operations
 * explicit until a supported read transport is integrated.
 */
export class DshDiscoveryUnavailableError extends Error {
  constructor(capability: 'session discovery' | 'session history') {
    super(`DSH ${capability} is unavailable through the public SDK protocol`)
    this.name = 'DshDiscoveryUnavailableError'
  }
}

export interface DiscoveredDshSession {
  id: string
  workspacePath: string
  title?: string
  updatedAt?: string
}

export class SessionDiscovery {
  async listByWorkspace(_workspacePath: string): Promise<DiscoveredDshSession[]> {
    throw new DshDiscoveryUnavailableError('session discovery')
  }

  async readHistory(_sessionId: string): Promise<string> {
    throw new DshDiscoveryUnavailableError('session history')
  }
}
