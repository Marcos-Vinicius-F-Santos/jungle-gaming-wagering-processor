import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4, v7 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { OUTBOX_REPOSITORY } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import type { OutboxRepository } from '../../src/modules/messaging/outbox/application/ports/outbox-repository.port';
import { OutboxMessage } from '../../src/modules/messaging/outbox/domain/outbox-message';
import { MikroOrmOutboxRepository } from '../../src/modules/messaging/outbox/infrastructure/persistence/mikro-orm-outbox.repository';
import { UNIT_OF_WORK } from '../../src/shared/application/ports/unit-of-work.port';
import type { UnitOfWork } from '../../src/shared/application/ports/unit-of-work.port';

describe('Transactional Outbox repository', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;
  let repository: OutboxRepository;
  let unitOfWork: UnitOfWork;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
    repository = app.get(OUTBOX_REPOSITORY);
    unitOfWork = app.get(UNIT_OF_WORK);
    await entityManager.getConnection().execute(
      `update outbox_messages
       set intervention_required = true,
           last_error_code = 'INTEGRATION_TEST_RESET',
           last_error_at = now()
       where published_at is null and intervention_required = false`,
    );
  });

  afterAll(async () => {
    await app.close();
  });

  test('claims a due event and confirms it conditionally', async () => {
    const occurredAt = new Date('2026-10-15T20:00:00.000Z');
    const event = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v4(),
      correlationId: `correlation-${v4()}`,
      eventType: 'WagerTransactionProcessed',
      version: 1,
      data: { transactionId: v4() },
      occurredAt,
    });
    await unitOfWork.execute(() => repository.enqueue(event));

    const claimed = await unitOfWork.execute(() => repository.claimDue({
      now: new Date('2026-10-15T20:00:01.000Z'),
      limit: 10,
      publisherName: `integration-${v4()}`,
      leaseUntil: new Date('2026-10-15T20:01:01.000Z'),
    }));

    expect(claimed).toHaveLength(1);
    expect(claimed[0].eventId).toBe(event.eventId);
    expect(await repository.markPublished(event.eventId, claimed[0].claimedBy!, new Date('2026-10-15T20:00:02.000Z'))).toBe(true);
    expect(await repository.markPublished(event.eventId, claimed[0].claimedBy!, new Date('2026-10-15T20:00:03.000Z'))).toBe(false);

    const rows = await entityManager.getConnection().execute<{ published_at: Date | null; claimed_by: string | null }[]>(
      'select published_at, claimed_by from outbox_messages where event_id = ?',
      [event.eventId],
    );
    expect(rows[0].published_at).not.toBeNull();
    expect(rows[0].claimed_by).toBeNull();
  });

  test('schedules a retry and keeps the event pending', async () => {
    const event = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v4(),
      correlationId: `correlation-${v4()}`,
      eventType: 'WagerTransactionRejected',
      version: 1,
      data: { transactionId: v4(), failureCode: 'BROKER_TIMEOUT' },
      occurredAt: new Date('2026-10-15T20:00:00.000Z'),
    });
    await unitOfWork.execute(() => repository.enqueue(event));
    const publisher = `integration-${v4()}`;
    await unitOfWork.execute(() => repository.claimDue({
      now: new Date('2026-10-15T20:00:01.000Z'),
      limit: 10,
      publisherName: publisher,
      leaseUntil: new Date('2026-10-15T20:01:01.000Z'),
    }));

    expect(await repository.scheduleRetry(
      event.eventId,
      publisher,
      new Date('2026-10-15T20:00:01.000Z'),
      new Date('2026-10-15T20:00:31.000Z'),
      'BROKER_TIMEOUT',
    )).toBe(true);

    const rows = await entityManager.getConnection().execute<{ attempts: number; published_at: Date | null; last_error_code: string }[]>(
      'select attempts, published_at, last_error_code from outbox_messages where event_id = ?',
      [event.eventId],
    );
    expect(rows[0]).toMatchObject({ attempts: 1, published_at: null, last_error_code: 'BROKER_TIMEOUT' });
  });

  test('allows only one concurrent publisher to claim the same event', async () => {
    const event = OutboxMessage.enqueue({
      eventId: v7(),
      aggregateId: v4(),
      correlationId: `correlation-${v4()}`,
      eventType: 'WagerTransactionPendingReference',
      version: 1,
      data: { transactionId: v4() },
      occurredAt: new Date('2026-10-15T20:00:00.000Z'),
    });
    await unitOfWork.execute(() => repository.enqueue(event));

    const firstEntityManager = entityManager.fork();
    const secondEntityManager = entityManager.fork();
    const firstRepository = new MikroOrmOutboxRepository(firstEntityManager);
    const secondRepository = new MikroOrmOutboxRepository(secondEntityManager);
    const options = {
      now: new Date('2026-10-15T20:00:01.000Z'),
      limit: 10,
      leaseUntil: new Date('2026-10-15T20:01:01.000Z'),
    };

    const claimWithTransaction = async (
      manager: EntityManager,
      instance: MikroOrmOutboxRepository,
      publisherName: string,
    ) => {
      await manager.begin();
      try {
        const result = await instance.claimDue({ ...options, publisherName });
        await manager.commit();
        return result;
      } catch (error) {
        await manager.rollback();
        throw error;
      }
    };
    const [first, second] = await Promise.all([
      claimWithTransaction(firstEntityManager, firstRepository, `first-${v4()}`),
      claimWithTransaction(secondEntityManager, secondRepository, `second-${v4()}`),
    ]);

    expect(first.length + second.length).toBe(1);
    const claimed = first[0] ?? second[0];
    expect(claimed.eventId).toBe(event.eventId);
    await repository.markIntervention(event.eventId, claimed.claimedBy!, new Date('2026-10-15T20:00:02.000Z'), 'CONCURRENCY_TEST');
  });
});
