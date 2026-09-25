import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { ModelSettings, RoundDetail, RoundMode, RoundSummary, SessionSummary } from '../../shared/contracts'

type SessionRow = {
  id: string
  dsh_session_id: string | null
  title: string
  workspace_path: string
  updated_at: string
  has_temporal_history: number
  permission: string
}

type RoundRow = {
  id: string
  sequence: number
  mode: RoundSummary['mode']
  status: RoundSummary['status']
  title: string
  updated_at: string
  body_markdown: string
}

type DraftRow = { draft: string; mode: RoundMode; revision: number }
type SettingsRow = { provider: string; model: string; base_url: string | null }

export interface PlanVersion {
  id: string
  submittedSpec: string
  planMarkdown: string
  createdAt: string
  dshActivityRef?: string
}

export interface VibeEntry {
  id: string
  specMarkdown: string
  assistantOutput: string
  executionOutcome: 'completed' | 'blocked' | 'failed' | 'interrupted'
  createdAt: string
}

export interface EvidenceRecord {
  id: string
  kind: 'command' | 'workspace' | 'artifact' | 'manual' | 'runtime'
  label: string
  detail: string
  outcome: 'passed' | 'failed' | 'observed'
  provenance: 'tool' | 'user' | 'model'
  observedAt: string
}

export interface ResultDocument {
  summary: string
  changes: string[]
  verification: string[]
  remaining: string[]
  createdAt: string
  loopTerminal?: {
    status: 'completed' | 'blocked' | 'budget_exhausted' | 'failed'
    reason: string
  }
}

export interface SessionLease {
  readonly sessionId: string
  readonly ownerToken: string
  assertHeld(): void
  release(): void
}

export type SavedSession = SessionSummary & { dshSessionId?: string }
export type SavedModelSettings = Omit<ModelSettings, 'hasCredential'>

const migrations = [
  `
    CREATE TABLE product_sessions (
      id TEXT PRIMARY KEY,
      dsh_session_id TEXT UNIQUE,
      workspace_path TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX product_sessions_workspace_recent
      ON product_sessions(workspace_path, updated_at DESC);

    CREATE TABLE rounds (
      id TEXT PRIMARY KEY,
      product_session_id TEXT NOT NULL REFERENCES product_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      mode TEXT NOT NULL CHECK (mode IN ('plan', 'vibe', 'loop')),
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'blocked', 'budget_exhausted', 'failed', 'interrupted')),
      title TEXT NOT NULL,
      body_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(product_session_id, sequence)
    );
    CREATE INDEX rounds_session_sequence ON rounds(product_session_id, sequence);

    CREATE TABLE drafts (
      product_session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
      draft TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'plan' CHECK (mode IN ('plan', 'vibe', 'loop')),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE model_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      base_url TEXT
    );
  `,
  `
    ALTER TABLE rounds ADD COLUMN runtime_active INTEGER NOT NULL DEFAULT 0 CHECK (runtime_active IN (0, 1));
    ALTER TABLE rounds ADD COLUMN closed_at TEXT;

    CREATE TABLE plan_versions (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      submitted_spec TEXT NOT NULL,
      plan_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dsh_activity_ref TEXT,
      UNIQUE(round_id, ordinal)
    );

    CREATE TABLE vibe_entries (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      spec_markdown TEXT NOT NULL,
      assistant_output TEXT NOT NULL,
      execution_outcome TEXT NOT NULL CHECK (execution_outcome IN ('completed', 'blocked', 'failed', 'interrupted')),
      created_at TEXT NOT NULL,
      UNIQUE(round_id, ordinal)
    );

    CREATE TABLE round_evidence (
      id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('command', 'workspace', 'artifact', 'manual', 'runtime')),
      label TEXT NOT NULL,
      detail TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'observed')),
      provenance TEXT NOT NULL CHECK (provenance IN ('tool', 'user', 'model')),
      observed_at TEXT NOT NULL
    );
    CREATE INDEX round_evidence_round ON round_evidence(round_id, observed_at);

    CREATE TABLE round_results (
      round_id TEXT PRIMARY KEY REFERENCES rounds(id) ON DELETE CASCADE,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE session_leases (
      product_session_id TEXT PRIMARY KEY REFERENCES product_sessions(id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL
    );
  `,
  `
    ALTER TABLE product_sessions ADD COLUMN permission TEXT NOT NULL DEFAULT 'workspace-write'
      CHECK (permission IN ('read-only', 'workspace-write', 'danger-full-access'));
  `
] as const

/** Product projection only. DSH remains authoritative for its conversation and runtime state. */
export class ProductStore {
  private readonly db: Database.Database
  private readonly leases = new Set<SessionLease>()

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    if (dbPath !== ':memory:') this.db.pragma('journal_mode = WAL')
    this.migrate()
  }

  private migrate(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > migrations.length) {
      throw new Error(`Product database version ${version} is newer than this app supports`)
    }
    for (let index = version; index < migrations.length; index += 1) {
      this.db.transaction(() => {
        this.db.exec(migrations[index])
        this.db.pragma(`user_version = ${index + 1}`)
      })()
    }
  }

  listSessions(workspacePath: string): SessionSummary[] {
    const rows = this.db.prepare(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.workspace_path = ? ORDER BY s.updated_at DESC
    `).all(workspacePath) as SessionRow[]
    return rows.map(toSessionSummary)
  }

  getSession(id: string): SessionSummary | undefined {
    const row = this.db.prepare(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.id = ?
    `).get(id) as SessionRow | undefined
    return row && toSessionSummary(row)
  }

  getSessionByDshId(dshSessionId: string): SessionSummary | undefined {
    const row = this.db.prepare(`
      SELECT s.*, EXISTS(SELECT 1 FROM rounds r WHERE r.product_session_id = s.id) AS has_temporal_history
      FROM product_sessions s WHERE s.dsh_session_id = ?
    `).get(dshSessionId) as SessionRow | undefined
    return row && toSessionSummary(row)
  }

  createSession(workspacePath: string, dshSessionId?: string, title?: string): SessionSummary {
    if (dshSessionId) {
      const existing = this.getSessionByDshId(dshSessionId)
      if (existing) {
        if (existing.workspacePath !== workspacePath) {
          throw new Error('DSH session is already associated with another workspace')
        }
        return existing
      }
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO product_sessions(id, dsh_session_id, workspace_path, title, created_at, updated_at, permission)
      VALUES (?, ?, ?, ?, ?, ?, 'workspace-write')
    `).run(id, dshSessionId ?? null, workspacePath, title?.trim() || 'New Session', now, now)
    return this.getSession(id)!
  }

  saveSession(session: SavedSession): void {
    const current = this.getSession(session.id)
    if (!current) throw new Error(`Unknown product session: ${session.id}`)
    if (current.workspacePath !== session.workspacePath) {
      throw new Error('A product session cannot change workspace')
    }
    this.db.prepare(`
      UPDATE product_sessions SET title = ?, dsh_session_id = COALESCE(?, dsh_session_id), updated_at = ?
      WHERE id = ?
    `).run(session.title, session.dshSessionId ?? null, new Date().toISOString(), session.id)
  }

  getDshSessionId(productSessionId: string): string | undefined {
    const row = this.db.prepare('SELECT dsh_session_id FROM product_sessions WHERE id = ?')
      .get(productSessionId) as { dsh_session_id: string | null } | undefined
    return row?.dsh_session_id ?? undefined
  }

  setDshSessionId(productSessionId: string, dshSessionId: string): void {
    const changed = this.db.prepare(`
      UPDATE product_sessions SET dsh_session_id = ?, updated_at = ?
      WHERE id = ? AND (dsh_session_id IS NULL OR dsh_session_id = ?)
    `).run(dshSessionId, new Date().toISOString(), productSessionId, dshSessionId)
    if (changed.changes !== 1) throw new Error('Product session is missing or bound to another DSH session')
  }

  getPermission(productSessionId: string): SessionSummary['permission'] {
    const row = this.db.prepare('SELECT permission FROM product_sessions WHERE id = ?')
      .get(productSessionId) as { permission: SessionSummary['permission'] } | undefined
    if (!row) throw new Error(`Unknown product session: ${productSessionId}`)
    return row.permission
  }

  setPermission(productSessionId: string, permission: SessionSummary['permission']): void {
    const changed = this.db.prepare('UPDATE product_sessions SET permission = ?, updated_at = ? WHERE id = ?')
      .run(permission, new Date().toISOString(), productSessionId)
    if (changed.changes !== 1) throw new Error(`Unknown product session: ${productSessionId}`)
  }

  /** Full per-Round projection for the renderer: versions, entries, evidence and result. */
  listRoundDetails(sessionId: string): RoundDetail[] {
    return this.listRounds(sessionId).map((round) => ({
      ...round,
      planVersions: this.listPlanVersions(round.id).map((version, index) => ({
        id: version.id, ordinal: index + 1, submittedSpec: version.submittedSpec,
        planMarkdown: version.planMarkdown, createdAt: version.createdAt
      })),
      vibeEntries: this.listVibeEntries(round.id).map((entry, index) => ({
        id: entry.id, ordinal: index + 1, specMarkdown: entry.specMarkdown,
        assistantOutput: entry.assistantOutput, executionOutcome: entry.executionOutcome,
        createdAt: entry.createdAt
      })),
      evidence: this.listEvidence(round.id),
      ...(this.getResult(round.id) ? { result: this.getResult(round.id)! } : {})
    }))
  }

  listRounds(sessionId: string): RoundSummary[] {
    const rows = this.db.prepare(`
      SELECT id, sequence, mode, status, title, updated_at, body_markdown
      FROM rounds WHERE product_session_id = ? ORDER BY sequence ASC
    `).all(sessionId) as RoundRow[]
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      mode: row.mode,
      status: row.status,
      title: row.title,
      updatedAt: row.updated_at,
      bodyMarkdown: row.body_markdown
    }))
  }

  saveRound(sessionId: string, round: RoundSummary): void {
    this.db.transaction(() => {
      const now = new Date().toISOString()
      const saved = this.db.prepare(`
        INSERT INTO rounds(id, product_session_id, sequence, mode, status, title, body_markdown, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          title = excluded.title,
          body_markdown = excluded.body_markdown,
          updated_at = excluded.updated_at
        WHERE rounds.product_session_id = excluded.product_session_id
          AND rounds.sequence = excluded.sequence
          AND rounds.mode = excluded.mode
      `).run(round.id, sessionId, round.sequence, round.mode, round.status,
        round.title, round.bodyMarkdown, now, round.updatedAt)
      if (saved.changes !== 1) {
        throw new Error('Round identity, sequence, or mode cannot change')
      }
      this.db.prepare('UPDATE product_sessions SET updated_at = ? WHERE id = ?')
        .run(now, sessionId)
    })()
  }

  /** Commit a mode boundary and its next Round as a single database transition. */
  transitionRound(sessionId: string, currentRoundId: string, next: RoundSummary): void {
    this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT sequence, mode, status FROM rounds WHERE id = ? AND product_session_id = ?
      `).get(currentRoundId, sessionId) as { sequence: number; mode: RoundMode; status: string } | undefined
      if (!current || current.status !== 'active') throw new Error('No active Round to transition')
      if (current.mode === next.mode || next.sequence !== current.sequence + 1) {
        throw new Error('Mode transition requires a different mode and consecutive sequence')
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE rounds SET status = 'completed', runtime_active = 0, closed_at = ?, updated_at = ?
        WHERE id = ? AND product_session_id = ?
      `).run(now, now, currentRoundId, sessionId)
      this.saveRound(sessionId, next)
    })()
  }

  markRoundExecutionStarted(sessionId: string, roundId: string): void {
    const result = this.db.prepare(`
      UPDATE rounds SET runtime_active = 1, updated_at = ?
      WHERE id = ? AND product_session_id = ? AND status = 'active' AND runtime_active = 0
    `).run(new Date().toISOString(), roundId, sessionId)
    if (result.changes !== 1) throw new Error('Round is not available for execution')
  }

  markRoundExecutionFinished(sessionId: string, roundId: string, status: RoundSummary['status']): void {
    const now = new Date().toISOString()
    const terminal = status !== 'active'
    const result = this.db.prepare(`
      UPDATE rounds SET runtime_active = 0, status = ?, closed_at = CASE WHEN ? THEN ? ELSE closed_at END, updated_at = ?
      WHERE id = ? AND product_session_id = ? AND status = 'active' AND runtime_active = 1
    `).run(status, terminal ? 1 : 0, now, now, roundId, sessionId)
    if (result.changes !== 1) throw new Error('Round has no active execution')
  }

  /** Called after restart, before restoring a Session projection. Idle Plan/Vibe Rounds remain active. */
  reconcileInterruptedRounds(sessionId: string): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE rounds SET status = 'interrupted', runtime_active = 0, closed_at = ?, updated_at = ?
      WHERE product_session_id = ? AND status = 'active' AND runtime_active = 1
    `).run(now, now, sessionId)
    return result.changes
  }

  appendPlanVersion(roundId: string, version: PlanVersion): void {
    this.db.transaction(() => {
      this.requireRoundMode(roundId, 'plan')
      const ordinal = this.nextOrdinal('plan_versions', roundId)
      this.db.prepare(`
        INSERT INTO plan_versions(id, round_id, ordinal, submitted_spec, plan_markdown, created_at, dsh_activity_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(version.id, roundId, ordinal, version.submittedSpec, version.planMarkdown,
        version.createdAt, version.dshActivityRef ?? null)
    })()
  }

  listPlanVersions(roundId: string): PlanVersion[] {
    const rows = this.db.prepare(`
      SELECT id, submitted_spec, plan_markdown, created_at, dsh_activity_ref
      FROM plan_versions WHERE round_id = ? ORDER BY ordinal
    `).all(roundId) as Array<{ id: string; submitted_spec: string; plan_markdown: string; created_at: string; dsh_activity_ref: string | null }>
    return rows.map((row) => ({ id: row.id, submittedSpec: row.submitted_spec,
      planMarkdown: row.plan_markdown, createdAt: row.created_at,
      ...(row.dsh_activity_ref ? { dshActivityRef: row.dsh_activity_ref } : {}) }))
  }

  appendVibeEntry(roundId: string, entry: VibeEntry): void {
    this.db.transaction(() => {
      this.requireRoundMode(roundId, 'vibe')
      const ordinal = this.nextOrdinal('vibe_entries', roundId)
      this.db.prepare(`
        INSERT INTO vibe_entries(id, round_id, ordinal, spec_markdown, assistant_output, execution_outcome, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(entry.id, roundId, ordinal, entry.specMarkdown, entry.assistantOutput,
        entry.executionOutcome, entry.createdAt)
    })()
  }

  listVibeEntries(roundId: string): VibeEntry[] {
    const rows = this.db.prepare(`
      SELECT id, spec_markdown, assistant_output, execution_outcome, created_at
      FROM vibe_entries WHERE round_id = ? ORDER BY ordinal
    `).all(roundId) as Array<{ id: string; spec_markdown: string; assistant_output: string; execution_outcome: VibeEntry['executionOutcome']; created_at: string }>
    return rows.map((row) => ({ id: row.id, specMarkdown: row.spec_markdown,
      assistantOutput: row.assistant_output, executionOutcome: row.execution_outcome,
      createdAt: row.created_at }))
  }

  saveEvidence(roundId: string, evidence: EvidenceRecord): void {
    this.db.prepare(`
      INSERT INTO round_evidence(id, round_id, kind, label, detail, outcome, provenance, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, detail = excluded.detail,
        outcome = excluded.outcome, provenance = excluded.provenance, observed_at = excluded.observed_at
      WHERE round_evidence.round_id = excluded.round_id
    `).run(evidence.id, roundId, evidence.kind, evidence.label, evidence.detail,
      evidence.outcome, evidence.provenance, evidence.observedAt)
  }

  listEvidence(roundId: string): EvidenceRecord[] {
    const rows = this.db.prepare(`
      SELECT id, kind, label, detail, outcome, provenance, observed_at
      FROM round_evidence WHERE round_id = ? ORDER BY observed_at, id
    `).all(roundId) as Array<{ id: string; kind: EvidenceRecord['kind']; label: string; detail: string;
      outcome: EvidenceRecord['outcome']; provenance: EvidenceRecord['provenance']; observed_at: string }>
    return rows.map((row) => ({ id: row.id, kind: row.kind, label: row.label,
      detail: row.detail, outcome: row.outcome, provenance: row.provenance,
      observedAt: row.observed_at }))
  }

  saveResult(roundId: string, document: ResultDocument): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO round_results(round_id, document_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(round_id) DO UPDATE SET document_json = excluded.document_json,
        updated_at = excluded.updated_at
    `).run(roundId, JSON.stringify(document), now, now)
  }

  getResult(roundId: string): ResultDocument | undefined {
    const row = this.db.prepare('SELECT document_json FROM round_results WHERE round_id = ?')
      .get(roundId) as { document_json: string } | undefined
    return row ? JSON.parse(row.document_json) as ResultDocument : undefined
  }

  /** SQLite write transaction serializes contenders in different Electron processes. */
  acquireSessionLease(sessionId: string, onLost?: () => void): SessionLease {
    if (!this.getSession(sessionId)) throw new Error(`Unknown product session: ${sessionId}`)
    const ownerToken = randomUUID()
    const durationMs = 15_000
    const acquire = this.db.transaction(() => {
      const now = Date.now()
      const changed = this.db.prepare(`
        INSERT INTO session_leases(product_session_id, owner_token, expires_at_ms)
        VALUES (?, ?, ?)
        ON CONFLICT(product_session_id) DO UPDATE SET
          owner_token = excluded.owner_token, expires_at_ms = excluded.expires_at_ms
        WHERE session_leases.expires_at_ms < ?
      `).run(sessionId, ownerToken, now + durationMs, now)
      return changed.changes === 1
    })
    if (!acquire()) throw new Error('Session is already open in another window or process')

    let released = false
    const assertHeld = (): void => {
      if (released) throw new Error('Session lease has been released or lost')
      const row = this.db.prepare('SELECT owner_token, expires_at_ms FROM session_leases WHERE product_session_id = ?')
        .get(sessionId) as { owner_token: string; expires_at_ms: number } | undefined
      if (!row || row.owner_token !== ownerToken || row.expires_at_ms <= Date.now()) {
        released = true
        clearInterval(timer)
        this.leases.delete(lease)
        onLost?.()
        throw new Error('Session lease has been lost')
      }
    }
    const renew = (): void => {
      if (released) return
      try {
        const now = Date.now()
        const result = this.db.prepare(`
          UPDATE session_leases SET expires_at_ms = ?
          WHERE product_session_id = ? AND owner_token = ? AND expires_at_ms > ?
        `).run(now + durationMs, sessionId, ownerToken, now)
        if (result.changes !== 1) assertHeld()
      } catch {
        if (!released) {
          released = true
          clearInterval(timer)
          this.leases.delete(lease)
          onLost?.()
        }
      }
    }
    const timer = setInterval(renew, 3_000)
    timer.unref()
    const lease: SessionLease = {
      sessionId,
      ownerToken,
      assertHeld,
      release: () => {
        if (released) return
        released = true
        clearInterval(timer)
        this.db.prepare('DELETE FROM session_leases WHERE product_session_id = ? AND owner_token = ?')
          .run(sessionId, ownerToken)
        this.leases.delete(lease)
      }
    }
    this.leases.add(lease)
    return lease
  }

  private requireRoundMode(roundId: string, mode: RoundMode): void {
    const row = this.db.prepare('SELECT mode FROM rounds WHERE id = ?')
      .get(roundId) as { mode: RoundMode } | undefined
    if (!row || row.mode !== mode) throw new Error(`Round is missing or is not ${mode}`)
  }

  private nextOrdinal(table: 'plan_versions' | 'vibe_entries', roundId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM ${table} WHERE round_id = ?`)
      .get(roundId) as { next: number }
    return row.next
  }

  getDraft(sessionId: string): { draft: string; mode: RoundMode } {
    const row = this.db.prepare('SELECT draft, mode, revision FROM drafts WHERE product_session_id = ?')
      .get(sessionId) as DraftRow | undefined
    return row ? { draft: row.draft, mode: row.mode } : { draft: '', mode: 'plan' }
  }

  getDraftWithRevision(sessionId: string): DraftRow {
    const row = this.db.prepare('SELECT draft, mode, revision FROM drafts WHERE product_session_id = ?')
      .get(sessionId) as DraftRow | undefined
    return row ?? { draft: '', mode: 'plan', revision: 0 }
  }

  saveDraft(sessionId: string, draft: string, mode: RoundMode): void {
    this.db.prepare(`
      INSERT INTO drafts(product_session_id, draft, mode, revision, updated_at)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(product_session_id) DO UPDATE SET
        draft = excluded.draft,
        mode = excluded.mode,
        revision = drafts.revision + 1,
        updated_at = excluded.updated_at
    `).run(sessionId, draft, mode, new Date().toISOString())
  }

  /** Clear only the draft that was submitted, preserving edits made while the runtime was busy. */
  clearDraftIfRevision(sessionId: string, revision: number): boolean {
    const result = this.db.prepare(`
      UPDATE drafts SET draft = '', revision = revision + 1, updated_at = ?
      WHERE product_session_id = ? AND revision = ?
    `).run(new Date().toISOString(), sessionId, revision)
    return result.changes === 1
  }

  getModelSettings(): ModelSettings {
    const row = this.db.prepare('SELECT provider, model, base_url FROM model_settings WHERE id = 1')
      .get() as SettingsRow | undefined
    return {
      provider: row?.provider ?? '',
      model: row?.model ?? '',
      ...(row?.base_url ? { baseUrl: row.base_url } : {}),
      hasCredential: false
    }
  }

  saveModelSettings(settings: SavedModelSettings): ModelSettings {
    this.db.prepare(`
      INSERT INTO model_settings(id, provider, model, base_url) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        provider = excluded.provider,
        model = excluded.model,
        base_url = excluded.base_url
    `).run(settings.provider, settings.model, settings.baseUrl ?? null)
    return this.getModelSettings()
  }

  close(): void {
    for (const lease of [...this.leases]) lease.release()
    this.db.close()
  }
}

function toSessionSummary(row: SessionRow): SessionSummary {
  const hasTemporalHistory = Boolean(row.has_temporal_history)
  return {
    id: row.id,
    ...(row.dsh_session_id ? { dshSessionId: row.dsh_session_id } : {}),
    title: row.title,
    workspacePath: row.workspace_path,
    updatedAt: row.updated_at,
    hasTemporalHistory,
    kind: hasTemporalHistory ? 'temporal' : row.dsh_session_id ? 'legacy' : 'new',
    permission: (row.permission as SessionSummary['permission']) ?? 'workspace-write'
  }
}
