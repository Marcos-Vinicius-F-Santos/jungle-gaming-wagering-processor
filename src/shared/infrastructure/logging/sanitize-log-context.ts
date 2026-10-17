import type { LogContext } from '../../application/ports/logger.port';

const MAX_STRING_LENGTH = 256;
const MAX_OBJECT_DEPTH = 3;
const MAX_OBJECT_ENTRIES = 40;
const RESERVED_KEYS = new Set(['event', 'level', 'timestamp']);
const SENSITIVE_KEY = /password|secret|token|authorization|credential|receipt.?handle|access.?key|private.?key|api.?key/i;
const PAYLOAD_KEY = /^(body|rawbody|messagebody|payload|data|amount|money|balance)$/i;

export function sanitizeLogContext(context: LogContext): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(context)) {
    if (isBlockedKey(key)) continue;
    const sanitizedValue = sanitizeValue(value, 0, seen);
    if (sanitizedValue !== undefined) sanitized[key] = sanitizedValue;
  }

  return sanitized;
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return {
      name: value.name.slice(0, 100),
      message: value.message.replaceAll(/\s+/g, ' ').slice(0, MAX_STRING_LENGTH),
    };
  }
  if (typeof value !== 'object') return String(value).slice(0, MAX_STRING_LENGTH);
  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_OBJECT_DEPTH) return '[Truncated]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value
        .slice(0, MAX_OBJECT_ENTRIES)
        .map((item) => sanitizeValue(item, depth + 1, seen));
    }

    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, MAX_OBJECT_ENTRIES)) {
      if (isBlockedKey(key)) continue;
      const sanitizedValue = sanitizeValue(nestedValue, depth + 1, seen);
      if (sanitizedValue !== undefined) output[key] = sanitizedValue;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function isBlockedKey(key: string): boolean {
  return RESERVED_KEYS.has(key.toLowerCase()) || SENSITIVE_KEY.test(key) || PAYLOAD_KEY.test(key);
}
