import type * as BusinessKnowledge from '@lobechat/business-knowledge';
// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { agentsKnowledgeBases, knowledgeBases } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  enterpriseKbState,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { agentRouter } from '../../agent';
import { knowledgeBaseRouter } from '../../knowledgeBase';
import { context, type EnterpriseWorld, seedEnterpriseWorld } from './enterpriseKnowledge.fixture';

vi.mock('@lobechat/business-knowledge', async (original) => ({
  ...(await original<typeof BusinessKnowledge>()),
  ...(await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
}));

let testDB: LobeChatDatabase;
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: vi.fn(function () {
    return testDB;
  }),
}));

vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(function () {
    return { deleteFiles: vi.fn() };
  }),
}));

const kbCaller = (userId: string) => knowledgeBaseRouter.createCaller(context(userId) as any);

describe('knowledgeBase router with enterprise knowledge bases', () => {
  let w: EnterpriseWorld;

  beforeAll(async () => {
    testDB = await getTestDB();
  });

  beforeEach(async () => {
    resetEnterpriseKbState();
    w = await seedEnterpriseWorld(testDB);
  });

  describe('list and detail', () => {
    it('shows a view member the enterprise library with its tier and the owner name', async () => {
      const list = await kbCaller(w.viewer).getKnowledgeBases();

      expect(list.map((kb) => kb.id)).toEqual([w.entA]);
      expect(list[0].enterprise).toEqual({ accessLevel: 'view', ownerName: 'Olivia Owner' });
    });

    it('shows an edit member the tier edit and the owner every library with owner tier', async () => {
      const editorList = await kbCaller(w.editor).getKnowledgeBases();
      expect(editorList[0].enterprise?.accessLevel).toBe('edit');

      const ownerList = await kbCaller(w.owner).getKnowledgeBases();
      const byId = new Map(ownerList.map((kb) => [kb.id, kb]));
      expect(byId.get(w.entA)?.enterprise).toEqual({
        accessLevel: 'owner',
        ownerName: 'Olivia Owner',
      });
      expect(byId.get(w.entB)?.enterprise?.accessLevel).toBe('owner');
      expect(byId.get(w.personalKb)?.enterprise).toBeUndefined();
    });

    it('hides enterprise libraries from a member without access', async () => {
      expect(await kbCaller(w.stranger).getKnowledgeBases()).toEqual([]);
    });

    it('returns the detail with the tier for a view member', async () => {
      const kb = await kbCaller(w.viewer).getKnowledgeBaseById({ id: w.entA });
      expect(kb?.id).toBe(w.entA);
      expect(kb?.enterprise?.accessLevel).toBe('view');
    });

    it('answers NOT_FOUND to a detail request without access, and when the policy store throws', async () => {
      await expect(kbCaller(w.stranger).getKnowledgeBaseById({ id: w.entA })).rejects.toMatchObject(
        {
          code: 'NOT_FOUND',
        },
      );
      await expect(kbCaller(w.viewer).getKnowledgeBaseById({ id: w.entB })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      enterpriseKbState.resolveThrows = true;
      await expect(kbCaller(w.viewer).getKnowledgeBaseById({ id: w.entA })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('leaves a personal library exactly as before', async () => {
      const kb = await kbCaller(w.owner).getKnowledgeBaseById({ id: w.personalKb });
      expect(kb?.id).toBe(w.personalKb);
      expect(kb).not.toHaveProperty('enterprise');
    });
  });

  describe('name and description', () => {
    it('lets only the owner rename', async () => {
      await kbCaller(w.owner).updateKnowledgeBase({ id: w.entA, value: { name: 'Renamed' } });
      const [row] = await testDB.select().from(knowledgeBases).where(eq(knowledgeBases.id, w.entA));
      expect(row.name).toBe('Renamed');

      await expect(
        kbCaller(w.editor).updateKnowledgeBase({ id: w.entA, value: { name: 'Hijack' } }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        kbCaller(w.viewer).updateKnowledgeBase({ id: w.entA, value: { name: 'Hijack' } }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        kbCaller(w.stranger).updateKnowledgeBase({ id: w.entA, value: { name: 'Hijack' } }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('delete, move and copy of the whole library', () => {
    it('refuses them for everyone, owner included, and NOT_FOUND without access', async () => {
      for (const userId of [w.owner, w.editor, w.viewer]) {
        await expect(kbCaller(userId).removeKnowledgeBase({ id: w.entA })).rejects.toMatchObject({
          code: 'FORBIDDEN',
        });
        await expect(
          kbCaller(userId).transferKnowledgeBase({ id: w.entA, targetWorkspaceId: 'ws-1' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        await expect(
          kbCaller(userId).copyKnowledgeBaseToWorkspace({ id: w.entA, targetWorkspaceId: 'ws-1' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      await expect(kbCaller(w.stranger).removeKnowledgeBase({ id: w.entA })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });

      const rows = await testDB.select().from(knowledgeBases).where(eq(knowledgeBases.id, w.entA));
      expect(rows).toHaveLength(1);
    });

    it('does not take enterprise libraries along with "delete all"', async () => {
      await kbCaller(w.owner).removeAllKnowledgeBases();

      const left = await testDB
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(eq(knowledgeBases.userId, w.owner));
      expect(left.map((row) => row.id).sort()).toEqual([w.entA, w.entB].sort());
    });

    it('still deletes a personal library', async () => {
      await kbCaller(w.owner).removeKnowledgeBase({ id: w.personalKb });
      const rows = await testDB
        .select()
        .from(knowledgeBases)
        .where(eq(knowledgeBases.id, w.personalKb));
      expect(rows).toHaveLength(0);
    });
  });

  describe('files inside the library', () => {
    it('rejects unlinking enterprise content and hides foreign rows', async () => {
      await expect(
        kbCaller(w.editor).removeFilesFromKnowledgeBase({
          ids: [w.entAFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await kbCaller(w.viewer)
        .removeFilesFromKnowledgeBase({ ids: [w.entAFile], knowledgeBaseId: w.entA })
        .catch((error) => expect(error.code).toBe('FORBIDDEN'));
      await expect(
        kbCaller(w.viewer).removeFilesFromKnowledgeBase({
          ids: [w.entAFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        kbCaller(w.stranger).removeFilesFromKnowledgeBase({
          ids: [w.entAFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      // A file that is not part of the library cannot be reached through it.
      await expect(
        kbCaller(w.editor).removeFilesFromKnowledgeBase({
          ids: [w.personalFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does not let a member link their own or the owner files into the library', async () => {
      await expect(
        kbCaller(w.editor).addFilesToKnowledgeBase({
          ids: [w.personalFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        kbCaller(w.stranger).addFilesToKnowledgeBase({
          ids: [w.personalFile],
          knowledgeBaseId: w.entA,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('mounting on an assistant', () => {
    let agentId: string;
    const agentCaller = (userId: string) => agentRouter.createCaller(context(userId) as any);

    const createAgent = async (userId: string) => {
      const { agents } = await import('@lobechat/database/schemas');
      const id = `agt_${Math.random().toString(36).slice(2)}`;
      await testDB.insert(agents).values({ id, slug: id, userId });
      return id;
    };

    it('requires view access to mount, NOT_FOUND otherwise', async () => {
      agentId = await createAgent(w.viewer);
      await agentCaller(w.viewer).createAgentKnowledgeBase({ agentId, knowledgeBaseId: w.entA });
      await expect(
        agentCaller(w.viewer).createAgentKnowledgeBase({ agentId, knowledgeBaseId: w.entB }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        agentCaller(w.viewer).toggleKnowledgeBase({
          agentId,
          knowledgeBaseId: w.entB,
          enabled: false,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const mounts = await testDB
        .select()
        .from(agentsKnowledgeBases)
        .where(eq(agentsKnowledgeBases.agentId, agentId));
      expect(mounts.map((row) => row.knowledgeBaseId)).toEqual([w.entA]);
    });

    it('lists a mounted library the caller lost access to as accessRevoked, keeping id and name', async () => {
      agentId = await createAgent(w.viewer);
      await agentCaller(w.viewer).createAgentKnowledgeBase({ agentId, knowledgeBaseId: w.entA });

      const before = await agentCaller(w.viewer).getKnowledgeBasesAndFiles({ agentId });
      const mounted = before.find((item) => item.id === w.entA)!;
      expect(mounted.enabled).toBe(true);
      expect(mounted.enterprise?.accessLevel).toBe('view');
      expect(mounted.accessRevoked).toBeUndefined();

      // The grant is withdrawn after the mount.
      enterpriseKbState.kbs.get(w.entA)!.grants = {};

      const after = await agentCaller(w.viewer).getKnowledgeBasesAndFiles({ agentId });
      const revoked = after.find((item) => item.id === w.entA)!;
      expect(revoked).toMatchObject({ accessRevoked: true, id: w.entA, name: 'Enterprise A' });
    });
  });
});
