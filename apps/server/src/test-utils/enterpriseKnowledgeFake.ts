import { vi } from 'vitest';

/**
 * In-memory stand-in for `@lobechat/business-knowledge`, so tests can declare
 * which knowledge bases are enterprise ones, who owns them and what tier each
 * member holds. Use as
 *
 * ```ts
 * vi.mock('@lobechat/business-knowledge', async () =>
 *   (await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge);
 * ```
 */
export interface FakeEnterpriseKb {
  grants: Record<string, 'edit' | 'view'>;
  ownerId: string;
}

export const enterpriseKbState = {
  enabled: true,
  kbs: new Map<string, FakeEnterpriseKb>(),
  /** Makes `resolveEnterpriseKbAccess` throw (fail-closed checks). */
  resolveThrows: false,
  uploaders: [] as {
    actor: { id: string; kind: string; name: string };
    itemId: string;
    knowledgeBaseId: string;
  }[],
};

export const resetEnterpriseKbState = () => {
  enterpriseKbState.enabled = true;
  enterpriseKbState.kbs.clear();
  enterpriseKbState.resolveThrows = false;
  enterpriseKbState.uploaders = [];
};

const levelOf = (kb: FakeEnterpriseKb, userId: string) =>
  kb.ownerId === userId ? ('owner' as const) : (kb.grants[userId] ?? null);

export const fakeBusinessKnowledge = {
  isEnterpriseKnowledgeEnabled: () => enterpriseKbState.enabled,
  listAccessibleEnterpriseKbs: vi.fn(async (_db: unknown, userId: string) =>
    [...enterpriseKbState.kbs]
      .map(([knowledgeBaseId, kb]) => ({
        knowledgeBaseId,
        level: levelOf(kb, userId),
        ownerId: kb.ownerId,
      }))
      .filter((item) => item.level),
  ),
  listEnterpriseKbIds: vi.fn(async (_db: unknown, ids?: string[]) =>
    [...enterpriseKbState.kbs.keys()].filter((id) => !ids || ids.includes(id)),
  ),
  recordEnterpriseKbItemUploaders: vi.fn(async (_db: unknown, items: any[]) => {
    enterpriseKbState.uploaders.push(...items);
  }),
  resolveEnterpriseKbAccess: vi.fn(
    async (_db: unknown, userId: string, knowledgeBaseId: string) => {
      if (enterpriseKbState.resolveThrows) throw new Error('policy store unavailable');
      const kb = enterpriseKbState.kbs.get(knowledgeBaseId);
      if (!kb) return { enterprise: false as const };
      const level = levelOf(kb, userId);
      return {
        access: level ? { knowledgeBaseId, level, ownerId: kb.ownerId } : null,
        enterprise: true as const,
      };
    },
  ),
};

export const fakeAccessState = { grants: [], version: 1 };
Object.assign(fakeBusinessKnowledge, {
  estimateEnterpriseKbAccess: vi.fn(async () => ({
    downgraded: 0,
    edit: 0,
    lost: 0,
    total: 0,
    view: 0,
  })),
  getEnterpriseKbAccessState: vi.fn(async () => fakeAccessState),
  getEnterpriseKbDirectory: vi.fn(async () => ({ departments: [], users: [] })),
  listEnterpriseKbEvents: vi.fn(async () => []),
  updateEnterpriseKbAccess: vi.fn(async (_db: unknown, params: { version: number }) => {
    if (params.version !== fakeAccessState.version)
      throw Object.assign(new Error('STALE_VERSION'), { code: 'STALE_VERSION' });
    return fakeAccessState;
  }),
});
