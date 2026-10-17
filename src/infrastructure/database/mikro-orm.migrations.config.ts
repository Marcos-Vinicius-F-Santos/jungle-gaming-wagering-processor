import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';

export default defineConfig({
  driver: PostgreSqlDriver,
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  entities: [],
  discovery: {
    warnWhenNoEntities: false,
  },
  migrations: {
    path: './dist/infrastructure/database/migrations',
    glob: '!(*.d).{js,ts}',
  },
});
