// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { validateOIDCJWT } from './jwt';

const signing = vi.hoisted(() => ({ jwks: '' }));
vi.mock('@/envs/auth', () => ({
  authEnv: {
    get JWKS_KEY() {
      return signing.jwks;
    },
  },
}));
vi.mock('@/libs/trpc/utils/tenantBinding', () => ({ isBoundToCurrentTenant: () => true }));

const contractRoot = new URL('../../../contracts/gateway-tenancy/v1/', import.meta.url);
const readContract = async (name: string) =>
  JSON.parse(await readFile(new URL(name, contractRoot), 'utf8'));
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  signing.jwks = JSON.stringify({
    keys: [{ ...(await exportJWK(privateKey)), alg: 'RS256', kid: 'ephemeral-gateway-test' }],
  });
});

const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'ephemeral-gateway-test' })
    .sign(privateKey);

describe('gateway ticket purpose isolation at ordinary Work authentication', () => {
  it('verifies the byte-for-byte vendored contract before consuming fixtures', async () => {
    const manifest = (await readContract('manifest.json')) as { files: Record<string, string> };
    for (const [file, expected] of Object.entries(manifest.files)) {
      const bytes = await readFile(new URL(file, contractRoot));
      expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(expected);
    }
  });

  it('consumes reverse-purpose-confusion with an actual RS256 signature', async () => {
    const fixture = await readContract('fixtures/token-claims.json');
    const scenario = fixture.cases.find(
      (entry: { id: string }) => entry.id === 'reverse-purpose-confusion',
    );
    expect(scenario).toBeDefined();
    const token = await sign(scenario.input);
    await expect(validateOIDCJWT(token)).rejects.toMatchObject({ code: scenario.expected.code });
  });

  it.each([
    { purpose: 'gateway-connect' },
    { iss: 'urn:lobehub:gateway-session', purpose: 'cli-sandbox' },
  ])('rejects the dedicated purpose or issuer independently: %j', async (claims) => {
    const token = await sign({ sub: 'user-shared', tid: 'tenant-A', ...claims });
    await expect(validateOIDCJWT(token)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('preserves an ordinary signed sandbox credential', async () => {
    const token = await sign({ purpose: 'cli-sandbox', sub: 'user-shared', tid: 'tenant-A' });
    await expect(validateOIDCJWT(token)).resolves.toMatchObject({ userId: 'user-shared' });
  });
});
