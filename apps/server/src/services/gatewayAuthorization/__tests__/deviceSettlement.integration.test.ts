import { randomUUID } from 'node:crypto';

import { devices, session } from '@lobechat/database/schemas';
import type { TenantScope } from '@lobechat/database/tenant';
import { runWithTenantScope } from '@lobechat/database/tenant';
import { GatewayHttpClient } from '@lobechat/device-gateway-client';
import type { GatewayDispatchEnvelope } from '@lobechat/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import type { LobeChatDatabase } from '@/database/type';
import { resetRedisClient } from '@/server/modules/Redis';
import { deviceGatewayTenancy } from '@/server/services/deviceGateway/tenancy';
import { redisService } from '@/server/services/redis';

import { claimGatewayAttempt, settleDeviceGatewayDispatch } from '../attempts';
import { runWithGatewaySource } from '../context';
import type { GatewayAttemptRecord, GatewayAuthorizationSource } from '../types';
import { seedGatewaySourceRows } from './testUtils';

const state = vi.hoisted(() => ({
  database: null as unknown,
  version: 7,
  effectiveState: 'active',
}));
vi.mock('@/envs/redis', () => ({
  getRedisConfig: () => ({
    enabled: true,
    prefix: 'b12-isolated',
    tls: false,
    url: process.env.GATEWAY_TEST_REDIS_URL,
  }),
}));
vi.mock('@/database/core/db-adaptor', () => ({ getServerDB: async () => state.database }));
vi.mock('@lobechat/business-auth', () => ({
  assertBusinessUserAccess: async () => {},
  isBusinessAuthorizationError: () => false,
}));
vi.mock('@/server/modules/Tenant/runtime', () => ({
  getTenantRuntime: () => ({
    gatewayAdmission: async (tenantId: string) => ({
      tenantId,
      acceptedVersion: state.version,
      effectiveState: state.effectiveState,
      checkedAt: Date.now(),
      leaseExpiresAt: Date.now() + 30_000,
    }),
  }),
}));

let db: LobeChatDatabase;
const tenantId = 'tenant-b12';
const subject = 'user-b12';
const source: GatewayAuthorizationSource = { kind: 'session', sessionId: 'session-b12', subject };
const context = { tenantId, sourceAcceptedVersion: 7 };
const principal = { kind: 'user' as const, id: subject };
const binding = {
  authorizationId: 'auth-b12',
  connectionId: 'connection-b12',
  connectionGeneration: 3,
};
const run = <T>(fn: () => T) =>
  runWithTenantScope(
    {
      tenantId,
      acceptedVersion: 7,
      slug: 'b12',
      endpoint: { basePath: '/t/b12', publicUrl: 'http://test.invalid/t/b12', version: 1 },
      session: { database: db },
    } as TenantScope,
    () => runWithGatewaySource(source, fn),
  );
let dispatched: GatewayAttemptRecord;
let reply: Record<string, unknown>;
let mutate: (() => Promise<void>) | undefined;
const makeClient = () =>
  new GatewayHttpClient({
    gatewayUrl: 'http://gateway.invalid',
    serviceToken: 'TEST-ONLY',
    ...deviceGatewayTenancy(),
  });
const invoke = () =>
  makeClient().invokeRpc({ userId: subject, deviceId: 'device-b12' }, { method: 'read' });

beforeAll(async () => {
  if (
    process.env.TEST_SERVER_DB === '1' ||
    !process.env.GATEWAY_TEST_REDIS_URL?.startsWith('redis://127.0.0.1:')
  )
    throw new Error('Only disposable PGlite and loopback Redis are allowed');
  db = await getTestDB();
  state.database = db;
}, 120_000);
beforeEach(async () => {
  state.version = 7;
  state.effectiveState = 'active';
  mutate = undefined;
  await seedGatewaySourceRows(db, {
    tenantId,
    subject,
    operationId: 'operation-b12',
    sessionId: source.sessionId,
    keyId: 'key-b12',
    keyHash: 'TEST-ONLY',
  });
  await db
    .insert(devices)
    .values({ userId: subject, deviceId: 'device-b12', identitySource: 'fallback' });
  await run(() =>
    redisService.gatewayAuthorization.putAuthorization(binding.authorizationId, {
      tenantId,
      userId: subject,
      authorizationId: binding.authorizationId,
      acceptedVersion: 7,
      principal,
      capabilities: ['device:connect', 'device:respond'],
      audience: 'urn:lobehub:gateway:device',
      deviceId: 'device-b12',
      connectionId: binding.connectionId,
      jti: randomUUID(),
      source,
      ticketExpiresAt: Date.now() + 300_000,
      authRecordExpiresAt: Date.now() + 300_000,
    }),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const envelope = JSON.parse(String(options.body)) as GatewayDispatchEnvelope;
      const record = await redisService.gatewayAuthorization.getAttempt(envelope.intent.attemptId);
      if (!record) throw new Error('Missing real prepared attempt');
      await claimGatewayAttempt(record, binding);
      dispatched = (await redisService.gatewayAuthorization.getAttempt(record.intent.attemptId))!;
      reply = {
        ...context,
        ...(envelope.intent.operationId ? { operationId: envelope.intent.operationId } : {}),
        attemptId: envelope.intent.attemptId,
        dispatchBinding: binding,
        outcome: 'completed',
        result: { data: { ok: 1 }, success: true },
      };
      await mutate?.();
      return new Response(JSON.stringify(reply), {
        headers: {
          'X-LobeHub-Gateway-Tenancy': '1',
          'X-LobeHub-Tenant-Id': tenantId,
        },
      });
    }),
  );
});
afterEach(async () => {
  await run(() => redisService.gatewayAuthorization.revokeAuthorization(binding.authorizationId));
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await resetRedisClient();
});

describe('Device inline result settles the original real Work attempt', () => {
  it('commits completed before returning a successful RPC without operation or toolCall IDs', async () =>
    run(async () => {
      expect(await invoke()).toMatchObject({ data: { ok: 1 }, success: true });
      expect(dispatched.state).toBe('claimed');
      const terminal = await redisService.gatewayAuthorization.getAttempt(
        dispatched.intent.attemptId,
      );
      expect(terminal).toMatchObject({
        state: 'completed',
        dispatchBinding: binding,
        dispatchResult: reply,
      });
      expect(terminal?.result).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }));
  it('settles a Device tool reply with an operation ID and no fabricated Agent toolCallId', async () =>
    run(async () => {
      mutate = async () => {
        reply.result = { content: 'read-only result', success: true };
      };
      expect(
        await makeClient().executeToolCall(
          { userId: subject, deviceId: 'device-b12', operationId: 'operation-b12' },
          { identifier: 'builtin', apiName: 'readFile', arguments: '{}' },
        ),
      ).toMatchObject({ success: true, content: 'read-only result' });
      const terminal = await redisService.gatewayAuthorization.getAttempt(
        dispatched.intent.attemptId,
      );
      expect(terminal).toMatchObject({
        state: 'completed',
        dispatchResult: { operationId: 'operation-b12' },
      });
      expect(terminal?.intent.toolCallId).toBeUndefined();
      expect(terminal?.result).toBeUndefined();
    }));
  it('records a legitimate business failure as completed, without treating transport unknown as completed', async () =>
    run(async () => {
      mutate = async () => {
        reply.result = { success: false, error: 'business failure' };
      };
      expect(await invoke()).toMatchObject({ success: false });
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'completed' });
      mutate = async () => {
        reply.outcome = 'executionUnknown';
        delete reply.result;
      };
      await expect(invoke()).rejects.toThrow('EXECUTION_UNKNOWN');
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'claimed' });
    }));
  it.each([
    'tenantId',
    'sourceAcceptedVersion',
    'attemptId',
    'operationId',
    'toolCallId',
    'dispatchBinding',
  ])('rejects a mismatching wire %s without settling or dispatching twice', async (field) =>
    run(async () => {
      mutate = async () => {
        reply[field] =
          field === 'sourceAcceptedVersion'
            ? 8
            : field === 'dispatchBinding'
              ? { ...binding, connectionId: 'replacement' }
              : 'replacement';
      };
      await expect(invoke()).rejects.toThrow();
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'claimed' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
  it.each([
    'action',
    'targetPrincipal',
    'actor',
    'resourceId',
    'operationId',
    'toolCallId',
    'attemptExpiresAt',
  ])('refuses a changed stored intent %s', async (field) =>
    run(async () => {
      mutate = async () => {
        const next = structuredClone(dispatched);
        if (field === 'action') next.intent.action = 'device.tool-call';
        if (field === 'targetPrincipal')
          next.intent.targetPrincipal = { kind: 'user', id: 'other' };
        if (field === 'actor') next.intent.actor.sourceRef = 'replacement';
        if (field === 'resourceId') next.intent.resourceId = 'other-device';
        if (field === 'operationId') next.intent.operationId = 'other-operation';
        if (field === 'toolCallId') next.intent.toolCallId = 'other-tool';
        if (field === 'attemptExpiresAt') next.intent.attemptExpiresAt += 1;
        expect(await redisService.gatewayAuthorization.compareAttempt(dispatched, next)).toBe(true);
      };
      await expect(invoke()).rejects.toThrow();
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'claimed' });
    }),
  );
  it.each([
    'source-revoked',
    'frozen',
    'version',
    'expired',
    'target-revoked',
    'binding-generation',
    'binding-authorization',
  ])('fails closed after dispatch when %s', async (condition) =>
    run(async () => {
      mutate = async () => {
        if (condition === 'source-revoked') await db.delete(session);
        if (condition === 'frozen') state.effectiveState = 'frozen';
        if (condition === 'version') state.version = 8;
        if (condition === 'target-revoked')
          await redisService.gatewayAuthorization.revokeAuthorization(binding.authorizationId);
        if (condition === 'binding-generation')
          reply.dispatchBinding = { ...binding, connectionGeneration: 4 };
        if (condition === 'binding-authorization')
          reply.dispatchBinding = { ...binding, authorizationId: 'unknown' };
        if (condition === 'expired')
          expect(
            await redisService.gatewayAuthorization.compareAttempt(dispatched, {
              ...dispatched,
              intent: { ...dispatched.intent, attemptExpiresAt: Date.now() - 1 },
            }),
          ).toBe(true);
      };
      await expect(invoke()).rejects.toThrow();
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'claimed' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
  it('rejects duplicate, missing and non-Device settlements and permits only one racing CAS winner', async () =>
    run(async () => {
      await invoke();
      const envelope = { ...context, intent: dispatched.intent };
      const completed = (await redisService.gatewayAuthorization.getAttempt(
        dispatched.intent.attemptId,
      ))!.dispatchResult!;
      await expect(
        settleDeviceGatewayDispatch({ envelope, reply: completed }),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CONFLICT' });
      const missingId = randomUUID();
      await expect(
        settleDeviceGatewayDispatch({
          envelope: { ...envelope, intent: { ...envelope.intent, attemptId: missingId } },
          reply: { ...completed, attemptId: missingId },
        }),
      ).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
      await expect(
        settleDeviceGatewayDispatch({
          envelope: {
            ...envelope,
            intent: {
              ...envelope.intent,
              action: 'operations.tool-execute',
              operationId: 'operation-b12',
              toolCallId: 'tool-b12',
            },
          },
          reply: completed,
        }),
      ).rejects.toMatchObject({ code: 'ATTEMPT_CONFLICT' });
      const prepared = await deviceGatewayTenancy().prepareDispatch!({
        action: 'device.rpc',
        targetPrincipal: principal,
        resourceId: 'device-b12',
      });
      const record = (await redisService.gatewayAuthorization.getAttempt(
        prepared.intent.attemptId,
      ))!;
      await claimGatewayAttempt(record, binding);
      const input = {
        envelope: prepared,
        reply: { ...completed, attemptId: prepared.intent.attemptId },
      };
      const outcomes = await Promise.allSettled([
        settleDeviceGatewayDispatch(input),
        settleDeviceGatewayDispatch(input),
      ]);
      expect(outcomes.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
      expect(
        await redisService.gatewayAuthorization.getAttempt(prepared.intent.attemptId),
      ).toMatchObject({ state: 'completed' });
    }));
  it('strictly rejects extra result-envelope fields instead of normalizing them away', async () =>
    run(async () => {
      mutate = async () => {
        reply.unrecognized = true;
      };
      await expect(invoke()).rejects.toMatchObject({ cause: { code: 'INVALID_GATEWAY_MESSAGE' } });
      expect(
        await redisService.gatewayAuthorization.getAttempt(dispatched.intent.attemptId),
      ).toMatchObject({ state: 'claimed' });
    }));
});
