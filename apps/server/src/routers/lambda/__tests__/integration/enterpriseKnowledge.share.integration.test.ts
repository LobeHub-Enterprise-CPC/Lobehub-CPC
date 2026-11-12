// @vitest-environment node
import type * as BusinessKnowledge from '@lobechat/business-knowledge';
import type { LobeChatDatabase } from '@lobechat/database';
import { agents, messages, messagesFiles, topics, topicShares } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentShareModel } from '@/database/models/agentShare';
import * as contentClassification from '@/server/services/enterpriseKnowledge/contentClassification';
import { getFileProxyUrl } from '@/server/services/file';
import { resetEnterpriseKbState } from '@/server/test-utils/enterpriseKnowledgeFake';

import { messageRouter } from '../../message';
import { conversationRouter } from '../../shareChat/conversation';
import { context, type EnterpriseWorld, seedEnterpriseWorld } from './enterpriseKnowledge.fixture';

vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof BusinessKnowledge>()),
  ...(await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
}));
let db: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => db }));
vi.mock('../../_helpers/agentShareFeatureGate', () => ({
  assertAgentShareVisitorEnabled: () => {},
}));
vi.mock('@/server/modules/Tenant/callbackUrl', () => ({
  buildTenantPublicUrl: (path: string) => `https://app.test/orgs/acme${path}`,
}));
const storage = vi.hoisted(() => ({ isDev: true }));
vi.mock('@/utils/env', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  get isDev() {
    return storage.isDev;
  },
}));
vi.mock('@/server/services/file/impls', () => ({
  createFileServiceModule: () => ({
    getFullFileUrl: async (url: string) => `https://storage.test/${url}`,
  }),
}));

describe('enterprise file URLs returned by shared conversations', () => {
  let w: EnterpriseWorld;
  let topicId: string;
  let shareId: string;
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    resetEnterpriseKbState();
    w = await seedEnterpriseWorld(db);
    const [agent] = await db.insert(agents).values({ userId: w.owner }).returning();
    const [topic] = await db
      .insert(topics)
      .values({ agentId: agent.id, userId: w.owner })
      .returning();
    topicId = topic.id;
    const [share] = await db
      .insert(topicShares)
      .values({ topicId, userId: w.owner, visibility: 'link' })
      .returning();
    shareId = share.id;
    const [message] = await db
      .insert(messages)
      .values({
        topicId,
        agentId: agent.id,
        content: 'Shared attachments',
        role: 'user',
        userId: w.owner,
      })
      .returning();
    await db.insert(messagesFiles).values(
      [w.entAFile, w.personalFile].map((fileId) => ({
        fileId,
        messageId: message.id,
        userId: w.owner,
      })),
    );
    vi.spyOn(AgentShareModel, 'findByShareIdWithAccessCheck').mockResolvedValue({
      agentId: agent.id,
      ownerId: w.owner,
      shareId: 'agent-share',
      visibility: 'link',
      workspaceId: null,
      shareConfig: {},
    } as Awaited<ReturnType<typeof AgentShareModel.findByShareIdWithAccessCheck>>);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['anonymous', true],
    ['anonymous', false],
    ['classic', true],
    ['classic', false],
    ['cursor', true],
    ['cursor', false],
    ['visitor', true],
    ['visitor', false],
  ] as const)(
    '%s never hands an enterprise storage URL to the visitor (dev=%s)',
    async (surface, isDev) => {
      storage.isDev = isDev;
      if (surface === 'visitor')
        await db.update(topics).set({ senderId: w.stranger }).where(eq(topics.id, topicId));
      const classify = vi.spyOn(contentClassification, 'classifyEnterpriseContentIds');
      const classic = messageRouter.createCaller(
        (surface === 'anonymous' ? {} : context(w.stranger)) as never,
      );
      const result =
        surface === 'classic' || surface === 'anonymous'
          ? await classic.getMessages({ topicShareId: shareId })
          : surface === 'cursor'
            ? (await classic.getMessagesByCursor({ topicShareId: shareId, direction: 'forward' }))
                .messages
            : await conversationRouter
                .createCaller(context(w.stranger) as never)
                .getMessages({ shareId: 'agent-share', topicId });
      const urls = new Map(
        result.flatMap((message) => message.fileList ?? []).map((file) => [file.id, file.url]),
      );
      expect(urls.get(w.entAFile)).toBe(getFileProxyUrl(w.entAFile));
      expect(urls.get(w.personalFile)).toBe(
        isDev ? 'https://storage.test/files/personal.txt' : getFileProxyUrl(w.personalFile),
      );
      expect(classify).toHaveBeenCalledTimes(1);
      expect(classify.mock.calls[0][1]).toEqual(
        expect.arrayContaining([w.entAFile, w.personalFile]),
      );
    },
  );
});
