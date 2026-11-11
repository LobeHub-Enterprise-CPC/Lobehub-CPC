import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEnterpriseKbState } from '@/server/test-utils/enterpriseKnowledgeFake';

import { enterpriseKnowledgeRouter } from '../../enterpriseKnowledge';
import { context, type EnterpriseWorld, seedEnterpriseWorld } from './enterpriseKnowledge.fixture';

vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof BusinessKnowledge>()),
  ...(await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
}));
let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: vi.fn(() => db) }));

describe('enterpriseKnowledge owner-only front-end access API', () => {
  let w: EnterpriseWorld;
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    resetEnterpriseKbState();
    w = await seedEnterpriseWorld(db);
  });
  const caller = (id: string) => enterpriseKnowledgeRouter.createCaller(context(id) as any);
  it.each(['viewer', 'editor', 'stranger'] as const)(
    'hides all five operations from %s',
    async (who) => {
      const c = caller(w[who]);
      for (const invoke of [
        () => c.getAccess({ knowledgeBaseId: w.entA }),
        () => c.updateAccess({ knowledgeBaseId: w.entA, grants: [], version: 1 }),
        () => c.estimateAccess({ knowledgeBaseId: w.entA, grants: [] }),
        () => c.directory({ keyword: 'owner' }),
        () => c.listEvents({ knowledgeBaseId: w.entA }),
      ])
        await expect(invoke()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    },
  );
  it('allows owner operations and maps stale versions to CONFLICT', async () => {
    const c = caller(w.owner);
    expect(await c.getAccess({ knowledgeBaseId: w.entA })).toEqual({ grants: [], version: 1 });
    expect(await c.updateAccess({ knowledgeBaseId: w.entA, grants: [], version: 1 })).toEqual({
      grants: [],
      version: 1,
    });
    expect(await c.estimateAccess({ knowledgeBaseId: w.entA, grants: [] })).toMatchObject({
      total: 0,
    });
    expect(await c.directory({})).toEqual({ departments: [], users: [] });
    expect(await c.listEvents({ knowledgeBaseId: w.entA })).toEqual([]);
    await expect(
      c.updateAccess({ knowledgeBaseId: w.entA, grants: [], version: 0 }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
