// @vitest-environment node
import '@/server/test-utils/serverTestConfig';

import type * as BusinessConst from '@lobechat/business-const';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createContextInner } from '@/libs/trpc/lambda/context';

const mockServerDB = {
  transaction: vi.fn(async (fn: (trx: unknown) => Promise<unknown>) => fn({ trx: true })),
};
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(function () {
    return mockServerDB;
  }),
}));

// Pin the cloud-only capability open so the visitor procedures under test are
// reachable: ENABLE_BUSINESS_FEATURES is false in OSS builds, and the
// shareChatProcedure middleware (`_helpers/agentShareFeatureGate.ts`) would
// otherwise reject everything with FORBIDDEN before reaching any of the
// behavior these tests exercise. The "gate itself" is covered separately by
// `_helpers/__tests__/agentShareFeatureGate.test.ts` and the dedicated
// "visitor capability" describe block below.
const mocks = vi.hoisted(() => ({
  businessConst: { ENABLE_BUSINESS_FEATURES: true },
}));
vi.mock('@lobechat/business-const', async () => {
  const actual = await vi.importActual<typeof BusinessConst>('@lobechat/business-const');
  return {
    ...actual,
    // `packages/utils/src/apiKey.ts` reads this dynamically (`import * as
    // businessConst`), pulled in transitively via the unmocked
    // `createContextInner` -> `ApiKeyModel` chain below. `actual` here
    // resolves to the cloud override, which omits this key entirely (see
    // that file's own doc comment), so vitest's mock-export validation has
    // no own property to find unless it is listed explicitly.
    API_KEY_PREFIX: (actual as Record<string, unknown>).API_KEY_PREFIX,
    // A getter (not a static spread) so per-test mutation of
    // `mocks.businessConst.ENABLE_BUSINESS_FEATURES` is observed by every
    // subsequent read, including inside the already-imported gate helper.
    get ENABLE_BUSINESS_FEATURES() {
      return mocks.businessConst.ENABLE_BUSINESS_FEATURES;
    },
  };
});

const mockAccessCheck = vi.fn();
vi.mock('@/database/models/agentShare', () => ({
  AgentShareModel: {
    findByShareIdWithAccessCheck: (...args: unknown[]) => mockAccessCheck(...args),
  },
}));
const mockFindById = vi.fn();
const mockQueryBySender = vi.fn();
const TopicModelMock = vi.fn(function () {
  return { findById: mockFindById, queryBySender: mockQueryBySender };
});
vi.mock('@/database/models/topic', () => ({ TopicModel: TopicModelMock }));
const mockMessageQuery = vi.fn();
const mockMessageQueryForVisitor = vi.fn();
vi.mock('@/database/models/message', () => ({
  MessageModel: class {
    query = mockMessageQuery;
    queryForVisitor = mockMessageQueryForVisitor;
  },
}));
const mockDocumentFindById = vi.fn();
const DocumentModelMock = vi.fn(function () {
  return { findById: mockDocumentFindById };
});
vi.mock('@/database/models/document', () => ({ DocumentModel: DocumentModelMock }));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    getFileAccessUrl = vi.fn(async () => 'https://s3/get');
  },
}));
const { shareChatRouter } = await import('../shareChat');
const VISITOR = 'visitor-1';
const OWNER = 'owner-1';
const share = {
  agentId: 'agt_share',
  ownerId: OWNER,
  shareConfig: { toolGrants: [] },
  shareId: 'share-1',
  visibility: 'link',
  workspaceId: null,
};
const visitorTopic = { agentId: share.agentId, id: 'tpc_visitor', senderId: VISITOR };
const createCaller = async () =>
  shareChatRouter.createCaller(await createContextInner({ userId: VISITOR }));

describe('shareChatRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.businessConst.ENABLE_BUSINESS_FEATURES = true;
    mockAccessCheck.mockResolvedValue(share);
    mockFindById.mockResolvedValue(visitorTopic);
    mockQueryBySender.mockResolvedValue([]);
  });

  describe('getTopics', () => {
    it("returns only the visitor's own topics via agentId + senderId scoping", async () => {
      const caller = await createCaller();
      await caller.getTopics({ shareId: 'share-1' });

      // Topic model is creator-scoped; the query narrows to this visitor's own
      // topics on this agent. `agent_shares` is 1:1 per agent, so `(agentId,
      // senderId)` identifies the share conversation without a share-instance
      // column on `topics`.
      expect(TopicModelMock).toHaveBeenCalledWith(expect.anything(), OWNER, undefined, undefined, {
        includeShareVisitor: true,
      });
      expect(mockQueryBySender).toHaveBeenCalledWith({
        agentId: share.agentId,
        senderId: VISITOR,
      });
    });

    it('does not tie the list page size to the live maxTopicsPerVisitor cap', async () => {
      // The cap only gates admission of NEW topics. A creator lowering it below
      // what a visitor already created must not hide those older conversations —
      // the visitor surface has no pagination or deep links to recover them.
      mockAccessCheck.mockResolvedValue({
        ...share,
        shareConfig: { ...share.shareConfig, maxTopicsPerVisitor: 1 },
      });
      const caller = await createCaller();
      await caller.getTopics({ shareId: 'share-1' });

      expect(mockQueryBySender).toHaveBeenCalledWith({
        agentId: share.agentId,
        senderId: VISITOR,
      });
    });
  });

  describe('getMessages', () => {
    it('rejects a topic on a different agent of the same creator', async () => {
      mockFindById.mockResolvedValue({ ...visitorTopic, agentId: 'agt_other' });
      const caller = await createCaller();

      await expect(
        caller.getMessages({ shareId: 'share-1', topicId: 'tpc_visitor' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockMessageQueryForVisitor).not.toHaveBeenCalled();
    });

    it('assembles Work summaries under the visitor’s own share scope', async () => {
      const caller = await createCaller();
      await caller.getMessages({
        includeFileWorks: true,
        shareId: 'share-1',
        topicId: 'tpc_visitor',
      });

      expect(mockMessageQueryForVisitor).toHaveBeenCalledWith(
        { includeFileWorks: true, topicId: 'tpc_visitor' },
        expect.objectContaining({
          redaction: {
            showErrorDetails: undefined,
            showModelInfo: undefined,
          },
          // Pinned to share + topic + VISITOR: the ordinary scope would join
          // the creator's Works, which must never reach a visitor surface.
          workAccessScope: {
            shareId: 'share-1',
            topicId: 'tpc_visitor',
            type: 'agentShare',
            visitorUserId: VISITOR,
          },
        }),
      );
    });

    it('keeps the Work-free response for clients that do not opt in', async () => {
      // Pre-Works clients (rolling deploys, cached sessions, lagging desktop
      // builds) omit `includeFileWorks` and cannot open visitor Work cards, so
      // no share scope is supplied and queryForVisitor skips Work assembly.
      const caller = await createCaller();
      await caller.getMessages({ shareId: 'share-1', topicId: 'tpc_visitor' });

      expect(mockMessageQueryForVisitor).toHaveBeenCalledWith(
        { includeFileWorks: undefined, topicId: 'tpc_visitor' },
        expect.objectContaining({ workAccessScope: undefined }),
      );
    });

    it('uses the visitor-redacted read path, never the raw creator-scoped query()', async () => {
      // Regression: getMessages must call `queryForVisitor` (which strips the
      // creator's sender/spend fields), not `query()` — see message.ts
      // `toVisitorMessage` for what that redaction guards against.
      const caller = await createCaller();
      await caller.getMessages({ shareId: 'share-1', topicId: 'tpc_visitor' });

      expect(mockMessageQuery).not.toHaveBeenCalled();
    });
  });

  describe('getDocument', () => {
    const document = {
      content: '# Notes',
      fileType: 'text/markdown',
      id: 'doc-1',
      metadata: { agentShare: { shareId: 'share-1' }, secret: 'creator-only' },
      title: 'Notes',
      updatedAt: new Date('2026-09-01T00:00:00.000Z'),
      userId: OWNER,
    };

    it('reads the document under the visitor’s share document scope', async () => {
      mockDocumentFindById.mockResolvedValue(document);
      const caller = await createCaller();

      await expect(
        caller.getDocument({ documentId: 'doc-1', shareId: 'share-1', topicId: 'tpc_visitor' }),
      ).resolves.toEqual({
        content: '# Notes',
        fileType: 'text/markdown',
        id: 'doc-1',
        title: 'Notes',
        updatedAt: document.updatedAt,
      });
      // Creator-scoped model + the share scope pinned to this visitor topic.
      expect(DocumentModelMock).toHaveBeenCalledWith(
        expect.anything(),
        OWNER,
        undefined,
        undefined,
        { shareId: 'share-1', topicId: 'tpc_visitor', type: 'agentShare', visitorUserId: VISITOR },
      );
      expect(mockDocumentFindById).toHaveBeenCalledWith('doc-1');
    });

    it('404s when the scoped lookup misses (creator or other-visitor document)', async () => {
      mockDocumentFindById.mockResolvedValue(undefined);
      const caller = await createCaller();

      await expect(
        caller.getDocument({ documentId: 'doc-1', shareId: 'share-1', topicId: 'tpc_visitor' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('rejects a topic that is not the visitor’s own', async () => {
      mockFindById.mockResolvedValue({ ...visitorTopic, senderId: 'someone-else' });
      const caller = await createCaller();

      await expect(
        caller.getDocument({ documentId: 'doc-1', shareId: 'share-1', topicId: 'tpc_visitor' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockDocumentFindById).not.toHaveBeenCalled();
    });
  });

  it('requires authentication', async () => {
    const caller = shareChatRouter.createCaller(await createContextInner());

    await expect(caller.getTopics({ shareId: 'share-1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
