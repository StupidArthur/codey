import type { HistoryState, SessionSummary } from '../../shared/contracts'
import type { DiscoveredDshSession } from './SessionDiscovery'

/**
 * Merge ProductStore records with ACP discovery. A DSH Session appears exactly
 * once: an existing product record wins; otherwise the discovered session is
 * shown as a legacy entry keyed by its DSH id. The projection is created only
 * when the user first opens it, never here.
 */
export function mergeSessions(
  product: SessionSummary[],
  discovered: DiscoveredDshSession[],
  workspacePath: string
): SessionSummary[] {
  const knownDshIds = new Set(product.flatMap((session) => (session.dshSessionId ? [session.dshSessionId] : [])))
  const merged = [...product]
  for (const item of discovered) {
    if (knownDshIds.has(item.id)) continue
    knownDshIds.add(item.id)
    merged.push({
      id: item.id,
      dshSessionId: item.id,
      title: item.title?.trim() || 'Existing DSH Session',
      workspacePath: item.workspacePath || workspacePath,
      updatedAt: item.updatedAt ?? '',
      hasTemporalHistory: false,
      kind: 'legacy',
      permission: 'workspace-write'
    })
  }
  merged.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  return merged
}

/** A legacy Session without Temporal Rounds exposes the read-only unavailable state. */
export function historyStateFor(session: SessionSummary | null, roundCount: number): HistoryState {
  if (!session || session.kind !== 'legacy' || roundCount > 0) return 'none'
  return 'legacy-unavailable'
}
