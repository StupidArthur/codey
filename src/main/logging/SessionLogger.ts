import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const DEFAULT_SESSION_LOG_DIR = 'D:\\codey-log'

/**
 * Append-only, per-product-session diagnostic log.
 *
 * JSONL keeps the file readable while preserving enough structure for later
 * analysis. Writes are serialized so high-frequency ACP updates stay ordered.
 */
export class SessionLogger {
  readonly filePath: string
  private queue: Promise<void>

  constructor(
    readonly sessionId: string,
    readonly directory: string = DEFAULT_SESSION_LOG_DIR
  ) {
    this.filePath = join(directory, `session-${safeName(sessionId)}.jsonl`)
    this.queue = mkdir(directory, { recursive: true }).then(() => undefined)
  }

  write(type: string, payload?: unknown): void {
    const record = {
      at: new Date().toISOString(),
      sessionId: this.sessionId,
      type,
      ...(payload === undefined ? {} : { payload: redact(payload) })
    }
    const line = JSON.stringify(record) + '\n'
    this.queue = this.queue
      .then(() => appendFile(this.filePath, line, { encoding: 'utf8' }))
      .catch(() => undefined)
  }

  async flush(): Promise<void> {
    await this.queue
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return value
  if (seen.has(value as object)) return '[Circular]'
  seen.add(value as object)

  if (Array.isArray(value)) return value.map((item) => redact(item, seen))

  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/credential|api[_-]?key|authorization|password|secret/i.test(key)) {
      output[key] = '[REDACTED]'
    } else {
      output[key] = redact(item, seen)
    }
  }
  return output
}
