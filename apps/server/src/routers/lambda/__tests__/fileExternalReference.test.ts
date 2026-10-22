// @vitest-environment node
import '@/server/test-utils/serverTestConfig';

import { getTestDB } from '@lobechat/database/test-utils';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import type { Transaction } from '@/database/type';

import { businessFileExternalReferenceGuard } from '../../../../../../packages/business-server/src/lambda-routers/file';

describe.skipIf(!!process.env.DATABASE_TEST_URL || process.env.TEST_SERVER_DB === '1')(
  'channel file references in tenant schemas',
  () => {
    it('checks the current search_path and does not read another tenant', async () => {
      const db = await getTestDB();
      const rollback = new Error('rollback disposable schema fixture');
      await expect(
        db.transaction(async (trx) => {
          for (const statement of `
        DROP TABLE IF EXISTS public.channel_messages CASCADE;
        CREATE SCHEMA tenant_a;
        CREATE SCHEMA tenant_b;
        CREATE TABLE tenant_a.channel_messages (id text PRIMARY KEY, file_ids jsonb);
        CREATE TABLE tenant_b.channel_messages (id text PRIMARY KEY, file_ids jsonb);
        INSERT INTO tenant_a.channel_messages VALUES ('message', '["file-a"]');
        SET LOCAL search_path TO tenant_a;
      `
            .split(';')
            .filter((s) => s.trim()))
            await trx.execute(sql.raw(statement));
          const check = () =>
            businessFileExternalReferenceGuard(trx as unknown as Transaction, 'file-a');
          expect(await check()).toBe(true);
          await trx.execute(sql`SET LOCAL search_path TO tenant_b`);
          expect(await check()).toBe(false);
          await trx.execute(sql`SET LOCAL search_path TO public`);
          expect(await check()).toBe(false);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    });
  },
);
