import { createHash } from 'node:crypto';

import type {
  PayloadHasher,
  WagerBusinessPayload,
} from './ports/payload-hasher.port';

export class CanonicalPayloadHasher implements PayloadHasher {
  hash(payload: WagerBusinessPayload): string {
    const canonicalJson = JSON.stringify(sortObjectKeys(payload));
    return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  }
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }

  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortObjectKeys(record[key])]),
    );
  }

  return value;
}
