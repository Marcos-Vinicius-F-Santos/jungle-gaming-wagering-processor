import 'reflect-metadata';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';
import { v4 } from 'uuid';

import { AppModule } from '../../src/app.module';
import { MikroOrmInboxRepository } from '../../src/modules/messaging/inbox/infrastructure/persistence/mikro-orm-inbox.repository';

describe('Inbox claim and lease persistence', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    app = await Test.createTestingModule({ imports: [AppModule] }).compile();
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('allows one active claim and reclaims the message after lease expiry', async () => {
    const repository = new MikroOrmInboxRepository(entityManager.fork());
    const consumerName = `claim-test-${v4()}`;
    const messageId = v4();
    const now = new Date('2026-10-16T10:00:00.000Z');
    const input = {
      consumerName,
      messageId,
      payloadHash: 'a'.repeat(64),
      now,
      leaseDurationMs: 30_000,
    };

    const first = await repository.claim({ ...input, claimedBy: 'instance-1' });
    expect(first.kind).toBe('CLAIMED');

    const active = await repository.claim({
      ...input,
      claimedBy: 'instance-2',
      now: new Date('2026-10-16T10:00:10.000Z'),
    });
    expect(active).toMatchObject({ kind: 'IN_FLIGHT', claimedBy: 'instance-1' });

    const reclaimed = await repository.claim({
      ...input,
      claimedBy: 'instance-2',
      now: new Date('2026-10-16T10:00:31.000Z'),
    });
    expect(reclaimed.kind).toBe('CLAIMED');
    if (reclaimed.kind === 'CLAIMED') expect(reclaimed.inbox.attempts).toBe(2);
  });

  test('allows only one concurrent claim and rejects a changed payload', async () => {
    const firstManager = entityManager.fork();
    const secondManager = entityManager.fork();
    const firstRepository = new MikroOrmInboxRepository(firstManager);
    const secondRepository = new MikroOrmInboxRepository(secondManager);
    const consumerName = `race-test-${v4()}`;
    const messageId = v4();
    const input = {
      consumerName,
      messageId,
      payloadHash: 'b'.repeat(64),
      now: new Date('2026-10-16T11:00:00.000Z'),
      leaseDurationMs: 30_000,
    };

    const results = await Promise.all([
      firstRepository.claim({ ...input, claimedBy: 'instance-1' }),
      secondRepository.claim({ ...input, claimedBy: 'instance-2' }),
    ]);
    expect(results.filter((result) => result.kind === 'CLAIMED')).toHaveLength(1);
    expect(results.filter((result) => result.kind === 'IN_FLIGHT')).toHaveLength(1);

    const conflict = await firstRepository.claim({
      ...input,
      payloadHash: 'c'.repeat(64),
      claimedBy: 'instance-3',
      now: new Date('2026-10-16T11:00:01.000Z'),
    });
    expect(conflict).toEqual({ kind: 'PAYLOAD_CONFLICT' });
  });
});
