// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { getTestDB } from '@lobechat/database/test-utils';
import { NextRequest } from 'next/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type EnterpriseWorld,
  seedEnterpriseWorld,
} from '@/server/routers/lambda/__tests__/integration/enterpriseKnowledge.fixture';
import {
  enterpriseKbState,
  resetEnterpriseKbState,
} from '@/server/test-utils/enterpriseKnowledgeFake';

import { GET } from './route';

vi.mock(
  '@lobechat/business-knowledge',
  async () => (await import('@/server/test-utils/enterpriseKnowledgeFake')).fakeBusinessKnowledge,
);
const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  sign: vi.fn(async () => 'https://storage.test/signed'),
}));
vi.mock('@/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        response: mocks.userId ? { user: { id: mocks.userId } } : null,
        headers: new Headers(),
      })),
    },
  },
}));
let db: LobeChatDatabase;
vi.mock('@/database/server', () => ({ getServerDB: vi.fn(() => db) }));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(function () {
    return {
      createDownloadUrl: mocks.sign,
      createCachedPreSignedUrlForPreview: mocks.sign,
      getFileMetadata: async () => ({ contentLength: 2 }),
      getFileStream: async () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ok'));
            controller.close();
          },
        }),
    };
  }),
}));
const request = (id: string, download = false) =>
  GET(new NextRequest(`https://app.test/f/${id}${download ? '?download=1' : ''}`), {
    params: Promise.resolve({ id }),
  });

describe('enterprise file proxy authorization before streaming', () => {
  let w: EnterpriseWorld;
  beforeAll(async () => {
    db = await getTestDB();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    resetEnterpriseKbState();
    w = await seedEnterpriseWorld(db);
    mocks.userId = null;
  });

  it.each([false, true])(
    'does not redirect or sign for anonymous and unauthorized callers (download=%s)',
    async (download) => {
      expect((await request(w.entAFile, download)).status).toBe(404);
      mocks.userId = w.stranger;
      expect((await request(w.entAFile, download)).status).toBe(404);
      expect(mocks.sign).not.toHaveBeenCalled();
    },
  );
  it('permits a viewer only for the exact granted library', async () => {
    mocks.userId = w.viewer;
    expect((await request(w.entAFile)).status).toBe(200);
    expect((await request(w.entBFile)).status).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('fails closed when the policy resolution throws', async () => {
    mocks.userId = w.viewer;
    enterpriseKbState.resolveThrows = true;
    expect((await request(w.entAFile)).status).toBe(404);
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it('preserves public-by-id behavior for non-enterprise files', async () => {
    expect((await request(w.personalFile)).status).toBe(302);
  });
});
