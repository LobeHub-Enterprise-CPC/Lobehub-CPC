import { readFileSync } from 'node:fs';

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { finalizeGatewayOperation } from './finalize';
import type { GatewayFinalizeRequest } from './types';
import { parseGatewayWire } from './wire';

const deps = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  version: 7,
  abandon: vi.fn(),
  resume: vi.fn(),
  interrupt: vi.fn(),
  update: vi.fn(),
  changes: {} as Record<string, unknown>,
}));
vi.mock('@lobechat/database/tenant', () => ({
  requireTenantScope: () => ({ tenantId: 'tenant-A', acceptedVersion: deps.version }),
}));
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: async () => ({
    select: () => ({ from: () => ({ where: () => sql`SELECT 1` }) }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        deps.changes = patch;
        return {
          where: (condition: unknown) => {
            deps.update(condition);
            return { returning: async () => [{ id: 'parent' }] };
          },
        };
      },
    }),
  }),
}));
vi.mock('./operationAuthority', () => ({ loadGatewayOperation: async () => deps.row }));
vi.mock('@/server/services/redis', () => ({
  redisService: { gatewayAuthorization: { interruptOperation: deps.interrupt } },
}));
vi.mock('@/server/services/agentRuntime/AbandonOperationService', () => ({
  AbandonOperationService: class {
    finalizeAbandoned = deps.abandon;
  },
}));
vi.mock('@/server/router-hono/agent/handlers/resumeAbandonedParent', () => ({
  resumeAbandonedParent: deps.resume,
}));
vi.mock('./attempts', () => ({ loadGatewayAttempt: vi.fn(), sameBinding: vi.fn() }));

const fixtures = JSON.parse(
  readFileSync(
    new URL('../../../../../contracts/gateway-tenancy/v1/fixtures/lifecycle.json', import.meta.url),
    'utf8',
  ),
) as { cases: { id: string; input: unknown }[] };
const fixtureInput = (id: string) => {
  const entry = fixtures.cases.find((item) => item.id === id);
  if (!entry) throw new Error(`Missing lifecycle fixture: ${id}`);
  return entry.input;
};
const input = fixtureInput('a1-server-only-watchdog-valid') as GatewayFinalizeRequest;
beforeEach(() => {
  vi.clearAllMocks();
  deps.version = 7;
  deps.row = {
    id: input.operationId,
    userId: 'user-shared',
    status: 'running',
    metadata: { sourceAcceptedVersion: 7 },
    parentOperationId: 'parent',
  };
  deps.abandon.mockImplementation(async () => {
    deps.row.status = 'error';
    return {
      abandoned: true,
      subAgentResume: { parentOperationId: 'parent' },
    };
  });
});
describe('A1 real watchdog finalization authority', () => {
  it('finalizes a server-only operation without any fake executor binding', async () => {
    const ack = await finalizeGatewayOperation(input);
    expect(ack).toEqual({
      tenantId: 'tenant-A',
      sourceAcceptedVersion: 7,
      operationId: input.operationId,
      outcome: 'finalized',
    });
    expect(deps.interrupt).toHaveBeenCalledWith(input.operationId, 7);
    expect(deps.resume).toHaveBeenCalledOnce();
  });
  it('cleans across versions but interrupts the parent instead of executing it', async () => {
    deps.version = 9;
    await finalizeGatewayOperation(input);
    expect(deps.abandon).toHaveBeenCalledWith(input.operationId, 'inactivity_watchdog', {
      cleanupOnly: true,
      expectedExecution: {
        tenantId: 'tenant-A',
        sourceAcceptedVersion: 7,
        parentOperationId: 'parent',
      },
    });
    expect(deps.resume).not.toHaveBeenCalled();
    expect(deps.changes).toMatchObject({
      status: 'interrupted',
      error: { message: 'EXECUTION_UNKNOWN' },
    });
  });
  it.each([
    { ...input, ownerPrincipal: { kind: 'user' as const, id: 'other' } },
    { ...input, sourceAcceptedVersion: 6 },
  ])('uses the same safe error for mismatched immutable authority', async (request) => {
    await expect(finalizeGatewayOperation(request)).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(deps.abandon).not.toHaveBeenCalled();
  });
  it.each([
    'a1-watchdog-binding-forbidden',
    'a1-watchdog-attempt-forbidden',
    'a1-executor-missing-binding',
  ])('rejects %s at the actual request parser', (id) => {
    expect(() => parseGatewayWire('finalizeRequest', fixtureInput(id))).toThrow(
      'INVALID_GATEWAY_MESSAGE',
    );
  });
});
