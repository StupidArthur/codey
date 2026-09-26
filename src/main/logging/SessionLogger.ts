import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_SESSION_LOG_DIR = 'D:\\codey-log'
const MAX_LOG_STRING = 12_000
const FLUSH_INTERVAL_MS = 120
const FLUSH_BATCH_SIZE = 64

/**
 * Append-only, per-product-session diagnostic log.
 *
 * JSONL keeps the file readable while preserving enough structure for later
 * analysis. Writes are batched and serialized so diagnostics add minimal I/O
 * overhead and never reorder high-frequency ACP updates.
 */
export class SessionLogger {
  readonly filePath: string
  private queue: Promise<void>
  private buffer: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private sequence = 0

  constructor(
    readonly sessionId: string,
    readonly directory: string = DEFAULT_SESSION_LOG_DIR
  ) {
    this.filePath = join(directory, `session-${safeName(sessionId)}.jsonl`)
    this.queue = mkdir(directory, { recursive: true }).then(() => undefined).catch(() => undefined)
  }

  write(type: string, payload?: unknown, context?: { runId?: string; runElapsedMs?: number }): void {
    try {
      const record = {
        seq: ++this.sequence,
        at: new Date().toISOString(),
        sessionId: this.sessionId,
        ...(context?.runId ? { runId: context.runId } : {}),
        ...(context?.runElapsedMs !== undefined ? { runElapsedMs: context.runElapsedMs } : {}),
        type,
        ...(payload === undefined ? {} : { payload: redact(payload) })
      }
      this.buffer.push(JSON.stringify(record) + '\n')
      if (this.buffer.length >= FLUSH_BATCH_SIZE) this.flushBatch()
      else this.scheduleFlush()
    } catch {
      // Diagnostics must never break the agent run.
    }
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.flushBatch()
    await this.queue
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushBatch()
    }, FLUSH_INTERVAL_MS)
    this.timer.unref?.()
  }

  private flushBatch(): void {
    if (this.buffer.length === 0) return
    const batch = this.buffer.join('')
    this.buffer = []
    this.queue = this.queue
      .then(() => appendFile(this.filePath, batch, { encoding: 'utf8' }))
      .catch(() => undefined)
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return sanitizeString(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return value
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)

  if (Array.isArray(value)) return value.map((item) => redact(item, seen))
  if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([key, item]) => [String(key), redact(item, seen)]))
  if (value instanceof Set) return [...value].map((item) => redact(item, seen))

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/credential|api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token/i.test(key)) {
      output[key] = '[REDACTED]'
    } else {
      output[key] = redact(item, seen)
    }
  }
  return output
}

function sanitizeString(value: string): string {
  let text = value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
  if (text.length > MAX_LOG_STRING) {
    text = `${text.slice(0, MAX_LOG_STRING)}… [truncated ${text.length - MAX_LOG_STRING} chars]`
  }
  return text
}
