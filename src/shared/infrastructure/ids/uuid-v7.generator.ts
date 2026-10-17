import { v7 } from 'uuid';

import type { IdGenerator } from '../../application/ports/id-generator.port';

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return v7();
  }
}
