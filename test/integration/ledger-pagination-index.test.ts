import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from '@mikro-orm/postgresql';

import { AppModule } from '../../src/app.module';

describe('PostgreSQL ledger pagination index', () => {
  let app: INestApplicationContext;
  let entityManager: EntityManager;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef;
    entityManager = app.get(EntityManager);
  });

  afterAll(async () => {
    await app.close();
  });

  test('has the wallet-scoped descending keyset index', async () => {
    const rows = await entityManager.getConnection().execute<{ indexname: string; indexdef: string }[]>(
      `select indexname, indexdef
       from pg_indexes
       where schemaname = current_schema()
         and tablename = 'wallet_ledger_entries'
         and indexname = 'wallet_ledger_entries_wallet_created_id_idx'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef.replaceAll('"', '').toLowerCase()).toContain(
      '(wallet_id, created_at desc, id desc)',
    );
  });
});
