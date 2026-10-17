// @vitest-environment node
import { createServer, type Server } from 'node:http';

import type { LobeChatDatabase } from '@lobechat/database';
import { agentSkills, files, globalFiles, users, workspaces } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { sha256 } from 'js-sha256';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentSkillModel } from '@/database/models/agentSkill';
import { SkillImporter } from '@/server/services/skill/importer';

import type { agentSkillsRouter } from '../../agentSkills';

const state = vi.hoisted(() => ({
  bytes: new Map<string, Buffer>(),
  db: undefined as unknown as LobeChatDatabase,
  outcomes: vi.fn(),
  tenant: 'a',
}));

vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: () => state.db }));
vi.mock('@/libs/trusted-client', () => ({
  generateTrustedClientToken: (identity: { tenantId: string }) => `fixture:${identity.tenantId}`,
  getTrustedClientTokenForSession: vi.fn(),
}));
vi.mock('@/libs/trusted-client/config', () => ({
  isSyntheticTrustedClientUserId: () => false,
  isTenantMarketMode: () => true,
}));
vi.mock('@/libs/trusted-client/resolveIdentity', () => ({
  resolveMarketServiceIdentity: ({ userId }: { userId: string }) => ({
    email: 'fixture@example.com',
    tenantId: state.tenant,
    userId,
  }),
}));
vi.mock('@/server/services/agentSignal/procedure', () => ({
  emitToolOutcomeSafely: state.outcomes,
  resolveToolOutcomeScope: () => ({ scope: 'user', scopeKey: 'fixture' }),
}));
vi.mock('@/server/services/agentSignal/store/adapters/redis/policyStateStore', () => ({
  redisPolicyStateStore: {},
}));
vi.mock('@/server/services/redis', () => ({ redisService: {} }));

// Replace only object transport: parser, resource hashing, models and SQL remain real.
vi.mock('@/server/services/file', () => ({
  FileService: class {
    constructor(
      _db: LobeChatDatabase,
      private readonly userId: string,
    ) {}

    async uploadBuffer(key: string, buffer: Buffer) {
      state.bytes.set(key, Buffer.from(buffer));
    }
    async createGlobalFile(input: {
      fileHash: string;
      fileType: string;
      metadata: Record<string, unknown>;
      size: number;
      url: string;
    }) {
      await state.db
        .insert(globalFiles)
        .values({
          creator: this.userId,
          fileType: input.fileType,
          hashId: input.fileHash,
          metadata: input.metadata,
          size: input.size,
          url: input.url,
        })
        .onConflictDoNothing();
    }
  },
}));

// Permit only this test's loopback fixture transport. The production arbitrary-URL
// SSRF guard is exercised by its owning package, not disabled in application code.
vi.mock('@lobechat/ssrf-safe-fetch', () => ({
  ssrfSafeFetch: (url: string, init?: RequestInit) => fetch(url, init),
}));

const identifier = 'same-identifier';
const userId = 'b05-market-download-fixture';
const sourcePath = `/api/v1/skills/${identifier}/download`;
const archives = new Map<string, Buffer>();
const requests: { path: string; token?: string }[] = [];
let origin: string;
let server: Server;
let mode: number | 'zip' | 'plain-zip' | 'bad-zip' | 'timeout' | 'redirect' = 'zip';
let redirectTarget: string;
let revision = '1';
let caller: ReturnType<typeof agentSkillsRouter.createCaller>;
let runtime: {
  service: { importFromMarket: (id: string) => Promise<unknown> };
};

const archive = (tenant: string, version = '1') =>
  Buffer.from(
    zipSync(
      {
        'skill/SKILL.md': strToU8(
          `---\nname: collision-skill\ndescription: Tenant ${tenant}\n---\n\n# ${tenant} ${version}\n`,
        ),
        'skill/references/tenant.txt': strToU8(`${tenant}:${version}`),
      },
      { mtime: new Date('2020-01-01T00:00:00Z') },
    ),
  );

const rows = async () => ({
  files: await state.db.select().from(files),
  globalFiles: await state.db.select().from(globalFiles),
  skills: await state.db.select().from(agentSkills),
});

beforeAll(async () => {
  // getTestDB uses PGlite without any dataDir when TEST_SERVER_DB != 1.
  expect(process.env.TEST_SERVER_DB).not.toBe('1');
  state.db = await getTestDB();
  server = createServer((req, res) => {
    const token = req.headers['x-lobe-trust-token'] as string | undefined;
    requests.push({ path: req.url!, token });
    if (req.url!.startsWith('/sink')) {
      res.end('redirect sink');
      return;
    }
    if (mode === 'timeout') return;
    if (mode === 'redirect') {
      res.writeHead(302, { location: redirectTarget }).end();
      return;
    }
    if (typeof mode === 'number') {
      res.writeHead(mode).end('Upstream fixture refusal');
      return;
    }
    const tenant = token?.replace('fixture:', '') ?? 'default';
    const version = new URL(req.url!, origin).searchParams.get('version') ?? revision;
    const bytes =
      mode === 'bad-zip'
        ? Buffer.from('not a zip')
        : mode === 'plain-zip'
          ? Buffer.from(zipSync({ 'SKILL.md': strToU8('Plain Market instructions.') }))
          : archive(tenant, version);
    archives.set(tenant, bytes);
    res.writeHead(200, { 'content-type': 'application/zip' }).end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubEnv('MARKET_BASE_URL', origin);
  const { agentSkillsRouter } = await import('../../agentSkills');
  caller = agentSkillsRouter.createCaller({ jwtPayload: { userId }, userId });
  const { skillStoreRuntime } =
    await import('@/server/services/toolExecution/serverRuntimes/skillStore');
  runtime = (await skillStoreRuntime.factory({
    serverDB: state.db,
    toolManifestMap: {},
    userId,
  })) as unknown as typeof runtime;
}, 60_000);

beforeEach(async () => {
  vi.restoreAllMocks();
  state.tenant = 'a';
  state.bytes.clear();
  state.outcomes.mockClear();
  requests.length = 0;
  archives.clear();
  mode = 'zip';
  revision = '1';
  // This process owns only a disposable, in-memory PGlite database.
  await state.db.delete(users).where(eq(users.id, userId));
  await state.db.delete(globalFiles);
  await state.db.insert(users).values({ email: 'fixture@example.com', id: userId });
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

describe('authenticated Market ZIP consumers', () => {
  it.each(['router', 'runtime'] as const)(
    'should import A bytes rather than a colliding default package through %s',
    async (consumer) => {
      if (consumer === 'router') await caller.importFromMarket({ identifier });
      else await runtime.service.importFromMarket(identifier);
      const { skills, globalFiles: storedFiles } = await rows();
      expect(skills).toHaveLength(1);
      expect(skills[0].content).toBe('# a 1');
      expect(skills[0]).toMatchObject({
        content: '# a 1',
        identifier,
        manifest: { sourceUrl: `${origin}${sourcePath}` },
        resources: {
          'references/tenant.txt': { fileHash: sha256('a:1'), size: 3 },
        },
        source: 'market',
        zipFileHash: sha256(archives.get('a')!),
      });
      expect(storedFiles.map((file) => file.hashId)).toContain(sha256('a:1'));
      expect([...state.bytes.values()].some((bytes) => bytes.equals(Buffer.from('a:1')))).toBe(
        true,
      );
      expect(requests).toEqual([{ path: sourcePath, token: 'fixture:a' }]);
      if (consumer === 'runtime') {
        expect(state.outcomes).toHaveBeenCalledWith(
          expect.objectContaining({ apiName: 'importFromZipUrl', status: 'succeeded' }),
        );
      }
    },
  );

  it('should keep B independent, preserve unchanged/update semantics and reject authored collisions', async () => {
    state.tenant = 'b';
    const first = await caller.importFromMarket({ identifier });
    expect(first!.skill.content).toBe('# b 1');
    const unchanged = await caller.importFromMarket({ identifier });
    expect(unchanged).toMatchObject({ skill: { id: first!.skill.id }, status: 'unchanged' });
    revision = '2';
    const updated = await caller.importFromMarket({ identifier });
    expect(updated).toMatchObject({
      skill: { content: '# b 2', id: first!.skill.id, identifier },
      status: 'updated',
    });
    await state.db.delete(agentSkills);
    await new SkillImporter(state.db, userId).createUserSkill({
      content: 'Authored',
      description: 'Authored description',
      identifier,
      name: 'Authored skill',
    });
    const before = await rows();
    const objectCount = state.bytes.size;
    await expect(caller.importFromMarket({ identifier })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await rows()).toEqual(before);
    expect(state.bytes.size).toBe(objectCount);
  });

  it('should preserve a requested version and parse Market packages without front matter', async () => {
    const { MarketService } = await import('@/server/services/market');
    const market = new MarketService({ userInfo: { tenantId: 'b', userId } });
    const { buffer } = await market.downloadSkill(identifier, '2.0.0');
    const result = await new SkillImporter(state.db, userId).importFromMarketZip(
      Buffer.from(buffer),
      {
        identifier,
        sourceUrl: market.getSkillDownloadUrl(identifier, '2.0.0'),
      },
    );
    expect(result.skill).toMatchObject({
      content: '# b 2.0.0',
      manifest: { sourceUrl: `${origin}${sourcePath}?version=2.0.0` },
      resources: { 'references/tenant.txt': { fileHash: sha256('b:2.0.0') } },
    });
    expect(requests).toEqual([{ path: `${sourcePath}?version=2.0.0`, token: 'fixture:b' }]);
    mode = 'plain-zip';
    const plain = await caller.importFromMarket({ identifier: 'plain-market' });
    expect(plain!.skill).toMatchObject({
      content: 'Plain Market instructions.',
      identifier: 'plain-market',
      name: 'plain-market',
      source: 'market',
    });
  });

  it('should refuse same-name authored skills and workspace overwrites before storing objects', async () => {
    await new SkillImporter(state.db, userId).createUserSkill({
      content: 'Authored',
      description: 'Authored description',
      identifier: 'authored',
      name: 'collision-skill',
    });
    const before = await rows();
    await expect(caller.importFromMarket({ identifier })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(await rows()).toEqual(before);
    expect(state.bytes.size).toBe(0);

    const workspaceId = 'b05-workspace';
    await state.db.insert(workspaces).values({
      id: workspaceId,
      name: 'Fixture',
      primaryOwnerId: userId,
      slug: workspaceId,
    });
    await new AgentSkillModel(state.db, userId, workspaceId).create({
      content: 'Original',
      description: 'Shared original',
      identifier,
      manifest: { description: 'Shared original', name: 'collision-skill' },
      name: 'collision-skill',
      source: 'market',
    });
    const snapshot = await rows();
    const bytes = archive('a');
    await expect(
      new SkillImporter(state.db, 'other-member', workspaceId).importFromMarketZip(bytes, {
        identifier,
        sourceUrl: `${origin}${sourcePath}`,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await rows()).toEqual(snapshot);
    expect(state.bytes.size).toBe(0);
  });

  it.each([401, 403, 404, 503, 'bad-zip'] as const)(
    'should not save anything after an upstream %s through either consumer',
    async (failure) => {
      mode = failure;
      for (const [consume, code] of [
        [() => caller.importFromMarket({ identifier }), 'BAD_GATEWAY'],
        [() => runtime.service.importFromMarket(identifier), 'DOWNLOAD_FAILED'],
      ] as const) {
        await expect(consume()).rejects.toMatchObject({ code });
        expect(await rows()).toEqual({ files: [], globalFiles: [], skills: [] });
        expect(state.bytes.size).toBe(0);
      }
      expect(requests).toHaveLength(2);
      expect(requests.every((request) => request.token === 'fixture:a')).toBe(true);
    },
  );

  it.each(['same origin', 'other origin'])(
    'should reject a redirect to %s before sending any credential to its sink',
    async (target) => {
      mode = 'redirect';
      redirectTarget =
        target === 'same origin'
          ? `${origin}/sink`
          : origin.replace('127.0.0.1', 'localhost') + '/sink';
      await expect(caller.importFromMarket({ identifier })).rejects.toMatchObject({
        code: 'BAD_GATEWAY',
        message: 'Failed to download skill from Market',
      });
      expect(requests).toEqual([{ path: sourcePath, token: 'fixture:a' }]);
      expect(await rows()).toEqual({ files: [], globalFiles: [], skills: [] });
      expect(state.bytes.size).toBe(0);
    },
  );

  it('should abort a stalled SDK download and return a controlled error without saving', async () => {
    mode = 'timeout';
    const realTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((delay) => {
      expect(delay).toBe(30_000);
      return realTimeout(1);
    });
    await expect(caller.importFromMarket({ identifier })).rejects.toMatchObject({
      code: 'BAD_GATEWAY',
      message: 'Failed to download skill from Market',
    });
    expect(await rows()).toEqual({ files: [], globalFiles: [], skills: [] });
    expect(state.bytes.size).toBe(0);
  });
});
