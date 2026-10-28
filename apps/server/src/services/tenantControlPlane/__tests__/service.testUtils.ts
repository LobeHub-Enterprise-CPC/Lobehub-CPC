import { expect, vi } from 'vitest';

import type { DatasourceBundle, LifecycleRequest, ProvisionRequest } from '../contracts';
import { tenantDbNames } from '../datasource';
import { MemoryControlPlaneRepository } from '../memoryRepository';
import {
  type LifecycleHooks,
  TenantControlPlaneService,
  type TenantDatabaseExecutor,
} from '../service';

export const TENANT = '7a0c3d2e-1111-4222-8333-944455556666';
export const NOW = new Date('2026-10-08T00:00:00.000Z');

export const bundle = (
  tenantId = TENANT,
  over: Partial<DatasourceBundle> = {},
): DatasourceBundle => {
  const names = tenantDbNames(tenantId);
  return {
    connectionVersion: 1,
    credentialBundleVersion: 1,
    database: 'lobehub',
    datasourceKind: 'lobehub',
    deploymentRef: 'default',
    host: 'pg-1.db.internal',
    mode: 'shared_schema',
    port: 5432,
    runtimeCredential: { password: 'run-secret', username: names.runtimeUsername },
    schemaName: names.schemaName,
    schemaOwner: {
      password: 'owner-secret',
      role: names.ownerUsername,
      username: names.ownerUsername,
    },
    schemaVersion: 1,
    tenantId,
    tls: { enabled: true, rejectUnauthorized: true },
    ...over,
  };
};

export const provision = (over: Partial<ProvisionRequest> = {}): ProvisionRequest => ({
  datasource: bundle(over.tenantId ?? TENANT),
  name: 'Acme',
  operationId: 'root-1:lobehub',
  rootOperationId: 'root-1',
  slug: 'acme',
  tenantId: TENANT,
  ...over,
});

export const lifecycle = (over: Partial<LifecycleRequest> = {}): LifecycleRequest => ({
  desiredState: 'frozen',
  eventId: 'evt-1',
  expiresAt: null,
  freezeReasons: ['manual'],
  occurredAt: NOW.toISOString(),
  tenantId: TENANT,
  version: 1,
  ...over,
});

export const hooks = (): LifecycleHooks => ({
  closeRealtime: vi.fn(async () => {}),
  drainTransactions: vi.fn(async () => {}),
  invalidateCaches: vi.fn(async () => {}),
  resumeQueue: vi.fn(async () => {}),
  stopQueue: vi.fn(async () => {}),
});

export const database = () =>
  ({
    checkOwnership: vi.fn(async () => {}),
    migrate: vi.fn(async () => {}),
    seed: vi.fn(async () => {}),
    verify: vi.fn(async () => {}),
    verifyDiscovery: vi.fn(async () => {}),
  }) satisfies TenantDatabaseExecutor;

/** The checks Console runs on every lifecycle result (RESPONSE_MISMATCH otherwise). */
export const assertConsoleInvariants = (
  r: Awaited<ReturnType<TenantControlPlaneService['receiveLifecycle']>>,
) => {
  expect(r.appliedVersion).toBeLessThanOrEqual(r.acceptedVersion);
  expect(r.acceptedVersion).toBeGreaterThanOrEqual(r.version);
  if (r.status === 'superseded') expect(r.acceptedVersion).toBeGreaterThan(r.version);
  if (r.status === 'applied') expect(r.appliedVersion).toBeGreaterThanOrEqual(r.version);
};

let repo: MemoryControlPlaneRepository;
let db: ReturnType<typeof database>;
let service: TenantControlPlaneService;

export const makeService = (isRegistrableSlug = (slug: string) => slug !== 'admin') =>
  new TenantControlPlaneService({
    database: db,
    isRegistrableSlug,
    now: () => NOW,
    repository: repo,
  });

export const resetService = () => {
  repo = new MemoryControlPlaneRepository();
  db = database();
  service = makeService();
  return { repo, db, service };
};

export const provisionApplied = async (request = provision()) => {
  await service.receiveProvision(request);
  return service.executeProvision(request.tenantId, request.operationId);
};

export const rotate = (over: Partial<DatasourceBundle> = {}) => ({
  datasource: bundle(TENANT, {
    credentialBundleVersion: 2,
    runtimeCredential: {
      password: 'run-secret-2',
      username: tenantDbNames(TENANT).runtimeUsername,
    },
    ...over,
  }),
  operationId: 'rot-1',
  tenantId: TENANT,
});
