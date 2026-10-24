import { randomUUID } from 'node:crypto';

import type { AgentState } from '@lobechat/agent-runtime';
import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import Redis from 'ioredis';
import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  interruptOperation,
  type OperationControlDeps,
} from '@/server/services/agentRuntime/AgentRuntimeService/operationControl';

import { AgentRuntimeCoordinator } from '../AgentRuntimeCoordinator';
import { createAgentStateManager } from '../factory';
import { InMemoryStreamEventManager } from '../InMemoryStreamEventManager';
import { agentRuntimeTenantKeyPrefix, closeAgentRuntimeRedisClient } from '../redis';

// Explicit opt-in: this URL must point at a disposable isolated Redis instance.
const url = process.env.TEST_AGENT_RUNTIME_REDIS_URL;
const tenantA = `runtime-test-a-${randomUUID()}`;
const tenantB = `runtime-test-b-${randomUUID()}`;
const operationId = 'same-operation-id';
const inTenant = <T>(tenantId: string, fn: () => T) =>
  runWithTenantScope({ session: {}, slug: tenantId, tenantId } as TenantScope, fn);

vi.mock('../GatewayStreamNotifier', () => ({ GatewayStreamNotifier: vi.fn() }));
vi.mock('@/envs/app', () => ({ appEnv: { enableQueueAgentRuntime: false } }));
vi.mock('@/envs/redis', () => ({
  redisEnv: { REDIS_URL: process.env.TEST_AGENT_RUNTIME_REDIS_URL },
}));
vi.mock('@/server/modules/Redis', () => ({ isRedisDisabledByEnv: () => false }));
// These services are not involved in stopping a running operation; no database,
// queue, or durable hooks may be touched by this infrastructure regression.
vi.mock('@/server/services/redis', () => ({ redisService: {} }));
vi.mock('@/server/services/agentRuntime/hooks', () => ({ hookDispatcher: {} }));
vi.mock('@/server/services/agentRuntime/hooks/deferredToolResultControl', () => ({
  controlDeferredToolResult: vi.fn(),
  loadDurableToolResultHooks: vi.fn(),
}));

afterAll(async () => {
  if (!url) return;
  await closeAgentRuntimeRedisClient();
  const inspect = new Redis(url);
  try {
    // Delete only keys owned by this test, even on a disposable server.
    for (const tenant of [tenantA, tenantB]) {
      const keys = await inspect.keys(`${agentRuntimeTenantKeyPrefix(tenant)}*`);
      if (keys.length) await inspect.del(...keys);
    }
  } finally {
    await inspect.quit();
  }
});

describe.skipIf(!url)('inline runtime shared state on isolated real Redis', () => {
  it('lets another instance interrupt a run while keeping other tenants isolated', async () => {
    const makeCoordinator = () =>
      new AgentRuntimeCoordinator({
        stateManager: createAgentStateManager(),
        streamEventManager: new InMemoryStreamEventManager(),
      });
    const a = inTenant(tenantA, makeCoordinator);
    const b = inTenant(tenantA, makeCoordinator);
    const findById = vi.fn(async () => undefined);
    const deps = {
      agentOperationModel: { findById },
      coordinator: b,
    } as unknown as OperationControlDeps;
    const state = {
      lastModified: new Date().toISOString(),
      messages: [],
      status: 'running',
      stepCount: 0,
    } as unknown as AgentState;
    await inTenant(tenantA, async () => {
      await a.createAgentOperation(operationId, { userId: 'owner-a' });
      await a.saveAgentState(operationId, state);
    });
    await inTenant(tenantB, async () => {
      expect(await b.loadAgentState(operationId)).toBeNull();
      expect(await b.isInterrupted(operationId)).toBe(false);
      expect(await interruptOperation(deps, operationId)).toBe(false);
      expect(await b.isInterrupted(operationId)).toBe(false);
      expect(findById).toHaveBeenCalledWith(operationId);
      findById.mockClear();
      await b.createAgentOperation(operationId, { userId: 'owner-b' });
      await b.saveAgentState(operationId, { ...state, stepCount: 7 });
    });

    await inTenant(tenantA, async () => {
      // The callback also crosses an async scheduling boundary like inline work.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(await b.loadAgentState(operationId)).toMatchObject({
        status: 'running',
        stepCount: 0,
      });
      expect(await interruptOperation(deps, operationId)).toBe(true);
      expect(await a.isInterrupted(operationId)).toBe(true);
      expect(await a.loadAgentState(operationId)).toMatchObject({ status: 'interrupted' });
      expect(await createAgentStateManager().getOperationMetadata(operationId)).toMatchObject({
        status: 'interrupted',
        tenantId: tenantA,
        userId: 'owner-a',
      });
    });
    await inTenant(tenantB, async () => {
      // Reuse the held manager from tenant A: command-time context must win.
      expect(await a.isInterrupted(operationId)).toBe(false);
      expect(await a.loadAgentState(operationId)).toMatchObject({
        status: 'running',
        stepCount: 7,
      });
      expect(await createAgentStateManager().getOperationMetadata(operationId)).toMatchObject({
        tenantId: tenantB,
        userId: 'owner-b',
      });
    });
    expect(findById).not.toHaveBeenCalled();
  });
});
