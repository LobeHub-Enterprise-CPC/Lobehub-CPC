import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { eq } from 'drizzle-orm';
import { decodeJwt, UnsecuredJWT } from 'jose';
import Provider from 'oidc-provider';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DrizzleAdapter } from '@/libs/oidc-provider/adapter';
import type * as KeyVaultsModule from '@/server/modules/KeyVaultsEncrypt';

import { getTestDB } from '../../../core/getTestDB';
import { users } from '../../../schemas';
import {
  oidcAccessTokens,
  oidcAuthorizationCodes,
  oidcClients,
  oidcDeviceCodes,
  oidcInteractions,
  oidcRefreshTokens,
  oidcSessions,
} from '../../../schemas/oidc';

// Model tests run outside a request, so there is no tenant scope: pin the
// gatekeeper to one test tenant's derived key.
vi.mock('@/server/modules/KeyVaultsEncrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof KeyVaultsModule>();
  class KeyVaultsGateKeeper extends actual.KeyVaultsGateKeeper {
    static initWithEnvKey = async () => actual.KeyVaultsGateKeeper.forTenant('test-tenant');
  }
  return { ...actual, KeyVaultsGateKeeper };
});

vi.mock('@lobechat/utils/server', () => ({
  getUserAuth: vi.fn(),
}));

const serverDB = await getTestDB();

// Test data
const testModelName = 'Session';
const testId = 'test-id';
const testUserId = 'test-user-id';
const testClientId = 'test-client-id';
const testGrantId = 'test-grant-id';
const testUserCode = 'test-user-code';
const testExpires = new Date(Date.now() + 3600 * 1000); // Expires in 1 hour

beforeEach(async () => {
  await serverDB.insert(users).values({ id: testUserId }).onConflictDoNothing();
});

// Clean up data after each test
afterEach(async () => {
  await serverDB.delete(oidcSessions);
  await serverDB.delete(oidcAuthorizationCodes);
  await serverDB.delete(users);
  await serverDB.delete(oidcClients);
  await serverDB.delete(oidcDeviceCodes);
  await serverDB.delete(oidcInteractions);
});

describe('DrizzleAdapter', () => {
  describe('constructor', () => {
    it('should create adapter instance correctly', () => {
      const adapter = new DrizzleAdapter(testModelName, serverDB);
      expect(adapter).toBeDefined();
    });
  });

  describe('upsert', () => {
    it.each(['Session', 'PushedAuthorizationRequest'])(
      'persists anonymous pre-auth %s until authentication',
      async (model) => {
        const adapter = new DrizzleAdapter(model, serverDB);
        const payload = {
          uid: testId,
          ...(model === 'PushedAuthorizationRequest'
            ? { request: new UnsecuredJWT({ client_id: testClientId, iss: testClientId }).encode() }
            : {}),
        };
        await adapter.upsert(testId, payload, 3600);
        expect(await adapter.find(testId)).toMatchObject(payload);
        const table = model === 'Session' ? oidcSessions : oidcAuthorizationCodes;
        const [anonymous] = await serverDB.select().from(table).where(eq(table.id, testId));
        expect(anonymous.userId).toBeNull();
        if (model === 'PushedAuthorizationRequest')
          expect((anonymous as typeof oidcAuthorizationCodes.$inferSelect).clientId).toBe(
            testClientId,
          );
        await adapter.upsert(testId, { ...payload, accountId: testUserId }, 3600);
        const [authenticated] = await serverDB.select().from(table).where(eq(table.id, testId));
        expect(authenticated.userId).toBe(testUserId);
      },
    );

    it('round-trips the real provider PAR across provider recreation before login', async () => {
      let provider: Provider;
      const server = createServer((req, res) => provider.callback()(req, res));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const issuer = `${origin}/orgs/test/oidc`;
      const clientId = 'adapter-protocol-client';
      const createProvider = () =>
        new Provider(issuer, {
          adapter: DrizzleAdapter.createAdapterFactory(serverDB),
          clients: [
            {
              client_id: clientId,
              grant_types: ['authorization_code'],
              redirect_uris: ['http://localhost:3210/callback'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
            },
            {
              client_id: 'adapter-confidential-client',
              client_secret: 'isolated-protocol-client-secret',
              grant_types: ['authorization_code'],
              redirect_uris: ['http://localhost:3210/callback'],
              response_types: ['code'],
              token_endpoint_auth_method: 'client_secret_basic',
            },
          ],
          cookies: { keys: ['isolated-protocol-cookie-key'] },
          features: { devInteractions: { enabled: false } },
          interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
          pkce: { required: () => true },
          renderError: async (ctx, out) => {
            ctx.status = 400;
            ctx.body = out;
          },
          routes: {
            authorization: '/orgs/test/oidc/auth',
            pushed_authorization_request: '/orgs/test/oidc/request',
          },
        });
      try {
        provider = createProvider();
        const invalid = await fetch(`${issuer}/request`, { method: 'POST' });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toMatchObject({ error: 'invalid_request' });
        expect(await serverDB.select().from(oidcAuthorizationCodes)).toEqual([]);
        const confidential = await fetch(`${issuer}/request`, {
          body: new URLSearchParams({
            code_challenge: 'a'.repeat(43),
            code_challenge_method: 'S256',
            redirect_uri: 'http://localhost:3210/callback',
            response_type: 'code',
            scope: 'openid',
          }),
          headers: {
            Authorization: `Basic ${Buffer.from('adapter-confidential-client:isolated-protocol-client-secret').toString('base64')}`,
          },
          method: 'POST',
        });
        const confidentialPAR = (await confidential.json()) as {
          error_description?: string;
          request_uri: string;
        };
        // oidc-provider 9.12.2 requires body client_id before PAR persistence,
        // even when HTTP Basic has already authenticated the client.
        expect(confidential.status).toBe(400);
        expect(confidentialPAR).toMatchObject({
          error: 'invalid_request',
          error_description: "missing required parameter 'client_id'",
        });
        expect(await serverDB.select().from(oidcAuthorizationCodes)).toEqual([]);

        const acceptedConfidential = await fetch(`${issuer}/request`, {
          body: new URLSearchParams({
            client_id: 'adapter-confidential-client',
            code_challenge: 'a'.repeat(43),
            code_challenge_method: 'S256',
            redirect_uri: 'http://localhost:3210/callback',
            response_type: 'code',
            scope: 'openid',
          }),
          headers: {
            Authorization: `Basic ${Buffer.from('adapter-confidential-client:isolated-protocol-client-secret').toString('base64')}`,
          },
          method: 'POST',
        });
        const acceptedPAR = (await acceptedConfidential.json()) as {
          error_description?: string;
          request_uri: string;
        };
        expect(acceptedConfidential.status, acceptedPAR.error_description).toBe(201);
        const confidentialId = acceptedPAR.request_uri.split(
          'urn:ietf:params:oauth:request_uri:',
        )[1];
        const [confidentialRow] = await serverDB
          .select()
          .from(oidcAuthorizationCodes)
          .where(eq(oidcAuthorizationCodes.id, confidentialId));
        expect(confidentialRow.clientId).toBe('adapter-confidential-client');
        expect(confidentialRow.userId).toBeNull();
        expect(decodeJwt((confidentialRow.data as { request: string }).request)).toMatchObject({
          client_id: 'adapter-confidential-client',
          iss: 'adapter-confidential-client',
        });
        provider = createProvider();
        const confidentialResume = await fetch(
          `${issuer}/auth?${new URLSearchParams({
            client_id: 'adapter-confidential-client',
            request_uri: acceptedPAR.request_uri,
          })}`,
          { redirect: 'manual' },
        );
        expect(confidentialResume.status).toBe(303);
        expect(confidentialResume.headers.get('location')).toMatch(/^\/interaction\//);

        const response = await fetch(`${issuer}/request`, {
          body: new URLSearchParams({
            client_id: clientId,
            code_challenge: 'a'.repeat(43),
            code_challenge_method: 'S256',
            redirect_uri: 'http://localhost:3210/callback',
            response_type: 'code',
            scope: 'openid',
          }),
          method: 'POST',
        });
        expect(response.status).toBe(201);
        const pushed = (await response.json()) as { expires_in: number; request_uri: string };
        expect(pushed.expires_in).toBeGreaterThan(0);
        const id = pushed.request_uri.split('urn:ietf:params:oauth:request_uri:')[1];
        const [row] = await serverDB
          .select()
          .from(oidcAuthorizationCodes)
          .where(eq(oidcAuthorizationCodes.id, id));
        expect(row.clientId).toBe(clientId);
        expect(row.userId).toBeNull();
        expect(row.data).not.toHaveProperty('clientId');
        expect(row.data).not.toHaveProperty('accountId');

        provider = createProvider();
        const authorize = await fetch(
          `${issuer}/auth?${new URLSearchParams({ client_id: clientId, request_uri: pushed.request_uri })}`,
          { redirect: 'manual' },
        );
        expect(authorize.status).toBe(303);
        expect(authorize.headers.get('location')).toMatch(/^\/interaction\//);

        // Starting login does not consume a PAR; completed authorization does.
        await new DrizzleAdapter('PushedAuthorizationRequest', serverDB).consume(id);
        const replay = await fetch(
          `${issuer}/auth?${new URLSearchParams({ client_id: clientId, request_uri: pushed.request_uri })}`,
          { redirect: 'manual' },
        );
        expect(replay.status).toBe(303);
        const errorRedirect = new URL(replay.headers.get('location')!, origin);
        expect(errorRedirect.pathname).toBe('/callback');
        expect(errorRedirect.searchParams.get('error')).toBe('invalid_request_uri');
        expect(errorRedirect.searchParams.has('code')).toBe(false);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });

    it('persists issuer-only internal PAR metadata without asserting HTTP reachability', async () => {
      const adapter = new DrizzleAdapter('PushedAuthorizationRequest', serverDB);
      const payload = { request: new UnsecuredJWT({ iss: testClientId }).encode(), trusted: true };

      await adapter.upsert(testId, payload, 60);

      const [row] = await serverDB
        .select()
        .from(oidcAuthorizationCodes)
        .where(eq(oidcAuthorizationCodes.id, testId));
      expect(row.clientId).toBe(testClientId);
      expect(row.userId).toBeNull();
      expect(await adapter.find(testId)).toEqual(payload);
      expect(row.data).not.toHaveProperty('clientId');
      expect(row.data).not.toHaveProperty('accountId');
    });

    it('preserves PAR consume, expiry and destroy behavior without changing its Request Object', async () => {
      const adapter = new DrizzleAdapter('PushedAuthorizationRequest', serverDB);
      const payload = {
        request: new UnsecuredJWT({ client_id: testClientId, iss: testClientId }).encode(),
        trusted: false,
      };

      await adapter.upsert(testId, payload, 60);
      expect(await adapter.find(testId)).toEqual(payload);
      await adapter.consume(testId);
      expect(await adapter.find(testId)).toBeUndefined();
      await adapter.destroy(testId);
      expect(
        await serverDB
          .select()
          .from(oidcAuthorizationCodes)
          .where(eq(oidcAuthorizationCodes.id, testId)),
      ).toEqual([]);
      await adapter.upsert(testId, payload, -1);
      expect(await adapter.find(testId)).toBeUndefined();
    });

    it('should create new record for Session model', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const payload = {
        accountId: testUserId,
        cookie: 'cookie-value',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await serverDB.query.oidcSessions.findFirst({
        where: eq(oidcSessions.id, testId),
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe(testId);
      expect(result?.userId).toBe(testUserId);
      expect(result?.data).toEqual(payload);
    });

    it('should create new record for Client model', async () => {
      const adapter = new DrizzleAdapter('Client', serverDB);
      const payload = {
        client_id: testClientId,
        client_uri: 'https://example.com',
        application_type: 'web',
        client_secret: 'secret',
        grant_types: ['authorization_code', 'refresh_token'],
        name: 'Test Client',
        redirectUris: ['https://example.com/callback'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      };

      await adapter.upsert(testClientId, payload, 0);

      const result = await serverDB.query.oidcClients.findFirst({
        where: eq(oidcClients.id, testClientId),
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe(testClientId);
      expect(result?.name).toBe(payload.name);
      expect(result?.redirectUris).toEqual(payload.redirectUris);
      expect(result?.scopes).toEqual(['openid', 'profile', 'email']);
    });

    it('should create new record for AccessToken model', async () => {
      const adapter = new DrizzleAdapter('AccessToken', serverDB);
      const payload = {
        accountId: testUserId,
        clientId: testClientId,
        grantId: testGrantId,
        scope: 'openid profile',
        iat: Math.floor(Date.now() / 1000),
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await serverDB.query.oidcAccessTokens.findFirst({
        where: eq(oidcAccessTokens.id, testId),
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe(testId);
      expect(result?.userId).toBe(testUserId);
      expect(result?.clientId).toBe(testClientId);
      expect(result?.grantId).toBe(testGrantId);
      expect(result?.data).toEqual(payload);
    });

    it('should create new record for DeviceCode model with userCode', async () => {
      const adapter = new DrizzleAdapter('DeviceCode', serverDB);
      const payload = {
        clientId: testClientId,
        userCode: testUserCode,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await serverDB.query.oidcDeviceCodes.findFirst({
        where: eq(oidcDeviceCodes.id, testId),
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe(testId);
      expect(result?.clientId).toBe(testClientId);
      expect(result?.userCode).toBe(testUserCode);
      expect(result?.data).toEqual(payload);
    });

    it('should update existing Session record', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const initialPayload = { accountId: testUserId, cookie: 'initial-cookie' };
      const updatedPayload = { accountId: testUserId, cookie: 'updated-cookie' };

      // Initial insert
      await adapter.upsert(testId, initialPayload, 3600);
      let result = await serverDB.query.oidcSessions.findFirst({
        where: eq(oidcSessions.id, testId),
      });
      expect(result?.data).toEqual(initialPayload);

      // Update
      await adapter.upsert(testId, updatedPayload, 7200); // New expiration time
      result = await serverDB.query.oidcSessions.findFirst({ where: eq(oidcSessions.id, testId) });
      expect(result?.data).toEqual(updatedPayload);
      // Verify expiresAt is also updated (approximately 2 hours later)
      expect(result?.expiresAt).toBeInstanceOf(Date);
      const expectedExpires = Date.now() + 7200 * 1000;
      expect(result!.expiresAt!.getTime()).toBeGreaterThan(expectedExpires - 5000); // Allow 5 second tolerance
      expect(result!.expiresAt!.getTime()).toBeLessThan(expectedExpires + 5000);
    });

    it('should update existing Client record', async () => {
      const adapter = new DrizzleAdapter('Client', serverDB);
      const initialPayload = {
        client_id: testClientId,
        client_uri: 'https://initial.com',
        name: 'Initial Client',
        redirectUris: ['https://initial.com/callback'],
        scopes: ['openid'],
      };
      const updatedPayload = {
        ...initialPayload,
        client_uri: 'https://updated.com',
        name: 'Updated Client',
        scopes: ['openid', 'profile'],
        scope: 'openid profile',
        redirectUris: ['https://updated.com/callback'],
      };

      // Initial insert
      await adapter.upsert(testClientId, initialPayload, 0);
      let result = await serverDB.query.oidcClients.findFirst({
        where: eq(oidcClients.id, testClientId),
      });

      expect(result?.name).toBe('Initial Client');
      expect(result?.clientUri).toBe('https://initial.com');
      expect(result?.scopes).toEqual(['openid']);

      // Update
      await adapter.upsert(testClientId, updatedPayload, 0);
      result = await serverDB.query.oidcClients.findFirst({
        where: eq(oidcClients.id, testClientId),
      });
      expect(result?.name).toBe('Updated Client');
      expect(result?.clientUri).toBe('https://updated.com');
      expect(result?.scopes).toEqual(['openid', 'profile']);
      expect(result?.redirectUris).toEqual(['https://updated.com/callback']);
    });

    describe('DeviceCode payload accountId protection', () => {
      afterEach(async () => {
        const { getUserAuth } = await import('@lobechat/utils/server');
        vi.mocked(getUserAuth).mockReset();
      });

      it('should NOT inject accountId into DeviceCode payload from auth context', async () => {
        const { getUserAuth } = await import('@lobechat/utils/server');
        vi.mocked(getUserAuth).mockResolvedValueOnce({ userId: testUserId } as any);

        const adapter = new DrizzleAdapter('DeviceCode', serverDB);
        const payload = {
          clientId: testClientId,
          userCode: testUserCode,
          inFlight: true,
          // No accountId — simulates oidc-provider's inFlight stage
        };

        await adapter.upsert(testId, payload, 3600);

        const result = await serverDB.query.oidcDeviceCodes.findFirst({
          where: eq(oidcDeviceCodes.id, testId),
        });

        expect(result).toBeDefined();
        // JSONB data must NOT contain accountId — oidc-provider uses its absence
        // to signal that authorization is still pending (inFlight).
        // Injecting it would cause the token endpoint to consume the code prematurely.
        expect(result?.data).not.toHaveProperty('accountId');
        // DB column userId should still be set for indexing
        expect(result?.userId).toBe(testUserId);
      });

      it('should preserve accountId in DeviceCode payload when oidc-provider explicitly sets it', async () => {
        const adapter = new DrizzleAdapter('DeviceCode', serverDB);
        const payload = {
          clientId: testClientId,
          userCode: testUserCode,
          accountId: testUserId, // Explicitly set by oidc-provider after consent
        };

        await adapter.upsert(testId, payload, 3600);

        const result = await serverDB.query.oidcDeviceCodes.findFirst({
          where: eq(oidcDeviceCodes.id, testId),
        });

        expect(result).toBeDefined();
        expect((result?.data as any).accountId).toBe(testUserId);
        expect(result?.userId).toBe(testUserId);
      });

      it('should still inject accountId into non-DeviceCode payload from auth context', async () => {
        const { getUserAuth } = await import('@lobechat/utils/server');
        vi.mocked(getUserAuth).mockResolvedValueOnce({ userId: testUserId } as any);

        const adapter = new DrizzleAdapter('Interaction', serverDB);
        const payload = {
          prompt: { name: 'consent' },
          // No accountId — auth context should inject it for non-DeviceCode models
        };

        await adapter.upsert(testId, payload, 3600);

        const result = await serverDB.query.oidcInteractions.findFirst({
          where: eq(oidcInteractions.id, testId),
        });

        expect(result).toBeDefined();
        // For non-DeviceCode models, accountId should be injected into payload
        expect((result?.data as any).accountId).toBe(testUserId);
      });
    });
  });

  describe('find', () => {
    it('should find existing record', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const payload = {
        accountId: testUserId,
        cookie: 'cookie-value',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await adapter.find(testId);

      expect(result).toBeDefined();
      expect(result).toEqual(payload);
    });

    it('should return correct format for Client model', async () => {
      const adapter = new DrizzleAdapter('Client', serverDB);
      const payload = {
        client_id: testClientId,
        client_uri: 'https://example.com',
        application_type: 'web',
        client_secret: 'secret',
        grant_types: ['authorization_code', 'refresh_token'],
        name: 'Test Client',
        redirectUris: ['https://example.com/callback'],
        response_types: ['code'],
        scope: 'openid profile email',
        token_endpoint_auth_method: 'client_secret_basic',
      };

      await adapter.upsert(testClientId, payload, 0);

      const result = await adapter.find(testClientId);

      expect(result).toBeDefined();
      expect(result.client_id).toBe(testClientId);
      expect(result.client_secret).toBe(payload.client_secret);
      expect(result.redirect_uris).toEqual(payload.redirectUris);
      expect(result.scope).toBe(payload.scope);
    });

    it('should return undefined if record does not exist', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const result = await adapter.find('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('should return undefined if record is expired', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const payload = {
        accountId: testUserId,
        cookie: 'cookie-value',
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      };

      // Negative expiration time means immediate expiration
      await adapter.upsert(testId, payload, -1);

      // Wait briefly to ensure expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await adapter.find(testId);

      expect(result).toBeUndefined();
    });

    it('should return undefined if record is consumed', async () => {
      const adapter = new DrizzleAdapter('AccessToken', serverDB);
      const payload = { accountId: testUserId, clientId: testClientId };
      await adapter.upsert(testId, payload, 3600);

      // Consume the record
      await adapter.consume(testId);

      // Find consumed record
      const result = await adapter.find(testId);
      expect(result).toBeUndefined();
    });

    it('should allow RefreshToken reuse within grace period', async () => {
      const adapter = new DrizzleAdapter('RefreshToken', serverDB);
      const payload = {
        accountId: testUserId,
        clientId: testClientId,
        grantId: testGrantId,
      };
      await adapter.upsert(testId, payload, 3600);

      // Consume the record
      await adapter.consume(testId);

      // Within grace period (180 seconds), should still find the record
      const result = await adapter.find(testId);
      expect(result).toBeDefined();
      expect(result).toEqual(payload);
    });

    it('should reject RefreshToken reuse after grace period expires', async () => {
      const adapter = new DrizzleAdapter('RefreshToken', serverDB);
      const payload = {
        accountId: testUserId,
        clientId: testClientId,
        grantId: testGrantId,
      };
      await adapter.upsert(testId, payload, 3600);

      // Directly update consumedAt to a past time (beyond grace period)
      // Grace period is 180 seconds, set to 200 seconds ago
      const pastConsumedAt = new Date(Date.now() - 200 * 1000);
      await serverDB
        .update(oidcRefreshTokens)
        .set({ consumedAt: pastConsumedAt })
        .where(eq(oidcRefreshTokens.id, testId));

      // Grace period expired, should return undefined
      const result = await adapter.find(testId);
      expect(result).toBeUndefined();
    });
  });

  describe('findByUserCode', () => {
    it('should find DeviceCode record by userCode', async () => {
      const adapter = new DrizzleAdapter('DeviceCode', serverDB);
      const payload = {
        clientId: testClientId,
        userCode: testUserCode,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await adapter.findByUserCode(testUserCode);

      expect(result).toBeDefined();
      expect(result).toEqual(payload);
    });

    it('should return undefined if DeviceCode record is expired', async () => {
      const adapter = new DrizzleAdapter('DeviceCode', serverDB);
      const payload = { clientId: testClientId, userCode: testUserCode };
      // Use negative expiresIn to make it expire immediately
      await adapter.upsert(testId, payload, -1);
      await new Promise((resolve) => setTimeout(resolve, 10)); // Brief wait to ensure expiration

      const result = await adapter.findByUserCode(testUserCode);
      expect(result).toBeUndefined();
    });

    it('should return undefined if DeviceCode record is consumed', async () => {
      const adapter = new DrizzleAdapter('DeviceCode', serverDB);
      const payload = { clientId: testClientId, userCode: testUserCode };
      await adapter.upsert(testId, payload, 3600);

      // Consume the record
      await adapter.consume(testId);

      // Find consumed record
      const result = await adapter.findByUserCode(testUserCode);
      expect(result).toBeUndefined();
    });

    it('should throw error on non-DeviceCode model', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      await expect(adapter.findByUserCode(testUserCode)).rejects.toThrow();
    });
  });

  describe('findSessionByUserId', () => {
    it('should find Session record by userId', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const payload = {
        accountId: testUserId,
        cookie: 'cookie-value',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      const result = await adapter.findSessionByUserId(testUserId);

      expect(result).toBeDefined();
      expect(result).toEqual(payload);
    });

    it('should return undefined on non-Session model', async () => {
      const adapter = new DrizzleAdapter('AccessToken', serverDB);
      const result = await adapter.findSessionByUserId(testUserId);
      expect(result).toBeUndefined();
    });
  });

  describe('destroy', () => {
    it('should delete existing record', async () => {
      const adapter = new DrizzleAdapter('Session', serverDB);
      const payload = {
        accountId: testUserId,
        cookie: 'cookie-value',
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      // Confirm record exists
      let result = await serverDB.query.oidcSessions.findFirst({
        where: eq(oidcSessions.id, testId),
      });
      expect(result).toBeDefined();

      // Delete record
      await adapter.destroy(testId);

      // Verify record is deleted
      result = await serverDB.query.oidcSessions.findFirst({
        where: eq(oidcSessions.id, testId),
      });
      expect(result).toBeUndefined();
    });
  });

  describe('consume', () => {
    it('should mark record as consumed', async () => {
      const adapter = new DrizzleAdapter('AccessToken', serverDB);
      const payload = {
        accountId: testUserId,
        clientId: testClientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };

      await adapter.upsert(testId, payload, 3600);

      // Consume the record
      await adapter.consume(testId);

      // Verify record is marked as consumed
      const result = await serverDB.query.oidcAccessTokens.findFirst({
        where: eq(oidcAccessTokens.id, testId),
      });

      expect(result).toBeDefined();
      expect(result?.consumedAt).not.toBeNull();
    });
  });

  describe('revokeByGrantId', () => {
    it('should revoke all records associated with specified grantId', async () => {
      // Create AccessToken record
      const accessTokenAdapter = new DrizzleAdapter('AccessToken', serverDB);
      const accessTokenPayload = {
        accountId: testUserId,
        clientId: testClientId,
        grantId: testGrantId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      await accessTokenAdapter.upsert(testId, accessTokenPayload, 3600);

      // Create RefreshToken record
      const refreshTokenAdapter = new DrizzleAdapter('RefreshToken', serverDB);
      const refreshTokenPayload = {
        accountId: testUserId,
        clientId: testClientId,
        grantId: testGrantId,
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      await refreshTokenAdapter.upsert('refresh-' + testId, refreshTokenPayload, 3600);

      // Revoke all records associated with testGrantId
      await accessTokenAdapter.revokeByGrantId(testGrantId);

      // Verify records are deleted
      const accessTokenResult = await serverDB.query.oidcAccessTokens.findFirst({
        where: eq(oidcAccessTokens.id, testId),
      });

      expect(accessTokenResult).toBeUndefined();

      const refreshTokenResult = await serverDB.query.oidcRefreshTokens.findFirst({
        where: eq(oidcRefreshTokens.id, `refresh-${testId}`),
      });
      console.log('refreshTokenResult:', refreshTokenResult);
      expect(refreshTokenResult).toBeUndefined();
    });

    it('should return directly on Grant model', async () => {
      // Grant model does not need to be revoked by grantId
      const adapter = new DrizzleAdapter('Grant', serverDB);
      await adapter.revokeByGrantId(testGrantId);
      // Test passes if no error is thrown
    });
  });

  describe('createAdapterFactory', () => {
    it('should create an adapter factory function', () => {
      const factory = DrizzleAdapter.createAdapterFactory(serverDB as any);
      expect(factory).toBeDefined();
      expect(typeof factory).toBe('function');

      const adapter = factory('Session');
      expect(adapter).toBeDefined();
      expect(adapter).toBeInstanceOf(DrizzleAdapter);
    });
  });

  describe('getTable (indirectly via public methods)', () => {
    it('should throw error when using unsupported model name', async () => {
      const invalidAdapter = new DrizzleAdapter('InvalidModelName', serverDB);
      // Call a method that triggers getTable
      await expect(invalidAdapter.find('any-id')).rejects.toThrow(
        'Unsupported model: InvalidModelName',
      );
      await expect(invalidAdapter.upsert('any-id', {}, 3600)).rejects.toThrow(
        'Unsupported model: InvalidModelName',
      );
      await expect(invalidAdapter.destroy('any-id')).rejects.toThrow(
        'Unsupported model: InvalidModelName',
      );
      await expect(invalidAdapter.consume('any-id')).rejects.toThrow(
        'Unsupported model: InvalidModelName',
      );
      await expect(invalidAdapter.revokeByGrantId('any-grant-id')).rejects.toThrow(
        'Unsupported model: InvalidModelName',
      );
    });
  });
});
