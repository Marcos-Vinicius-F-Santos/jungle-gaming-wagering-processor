import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';

import type { UnitOfWork } from '../../application/ports/unit-of-work.port';

@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly entityManager: EntityManager) {}

  execute<T>(work: () => Promise<T>): Promise<T> {
    return this.entityManager.transactional(() => work());
  }
}
