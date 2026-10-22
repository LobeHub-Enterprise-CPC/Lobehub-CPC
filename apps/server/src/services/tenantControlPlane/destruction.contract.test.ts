import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { bundle, database, provision } from './__tests__/service.testUtils';
import {
  ControlPlaneError,
  DESTRUCTION_PHASES,
  destructionQuerySchema,
  destructionRequestSchema,
  SAFE_ERROR_CODES,
} from './contracts';
import { MemoryControlPlaneRepository } from './memoryRepository';
import { TenantControlPlaneService } from './service';

// contracts/tenant-control-plane/tenant-destruction.json is Console's, byte-identical here. Every
// request and answer it samples for `lobehub` is replayed against this application's real answers.
const contract = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        './../../../../../contracts/tenant-control-plane/tenant-destruction.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
);
const sample = contract.samples;
const TENANT = sample.lobehub.barrier.request.tenantId as string;
const OP = sample.lobehub.barrier.request.destroyOperationId as string;

/** The clock of the sample: barrier at 08:00:00, everything after at 08:00:09. */
const BARRIER_AT = new Date(sample.lobehub.barrier.response.terminalEstablishedAt);
const DONE_AT = new Date(sample.lobehub.unregister.response.completedAt);

describe('tenant-destruction.json', () => {
  const setup = () => {
    const repo = new MemoryControlPlaneRepository();
    let now = BARRIER_AT;
    const service = new TenantControlPlaneService({
      database: database(),
      destruction: { retirePool: () => true },
      isRegistrableSlug: () => true,
      now: () => now,
      repository: repo,
    });
    return {
      repo,
      service,
      at: (next: Date) => {
        now = next;
      },
    };
  };

  it('is the copy of the contract this application implements', () => {
    expect(contract.contract).toBe('tenant-destruction');
    expect(contract.applications).toContain('lobehub');
    expect(contract.basePath).toBe('/api/internal/control-plane');
    expect(contract.phases).toEqual([...DESTRUCTION_PHASES]);
  });

  it('accepts the sampled requests and rejects malformed ones with a schema error', () => {
    for (const { request } of Object.values<any>(sample.lobehub).filter((s) => s.request))
      expect(destructionRequestSchema.safeParse(request).success).toBe(true);
    expect(destructionQuerySchema.safeParse(sample.status.none.query).success).toBe(true);
    expect(destructionQuerySchema.safeParse(sample.status.complete.query).success).toBe(true);
    const base = sample.lobehub.barrier.request;
    for (const bad of [
      { ...base, phase: 'purge' },
      { ...base, destroyOperationId: 'not-a-uuid' },
      { ...base, tenantId: 'ACME' },
      { ...base, slug: 'acme' },
      { destroyOperationId: base.destroyOperationId, phase: 'barrier' },
    ])
      expect(destructionRequestSchema.safeParse(bad).success).toBe(false);
    expect(
      destructionQuerySchema.safeParse({ destroyOperationId: 'x', tenantId: TENANT }).success,
    ).toBe(false);
  });

  it('answers the sampled sequence byte for byte: barrier, drain, unregister, replay, status', async () => {
    const { at, service } = setup();
    await service.receiveProvision(provision({ datasource: bundle(TENANT), tenantId: TENANT }));
    await service.executeProvision(TENANT, 'root-1:lobehub');
    await service.receiveLifecycle({
      desiredState: 'frozen',
      eventId: 'evt-1',
      expiresAt: null,
      freezeReasons: ['manual'],
      occurredAt: BARRIER_AT.toISOString(),
      tenantId: TENANT,
      version: 1,
    });

    expect(await service.destruction.status(TENANT)).toEqual(sample.status.none.response);
    expect(await service.destruction.apply(sample.lobehub.barrier.request)).toEqual(
      sample.lobehub.barrier.response,
    );
    expect(await service.destruction.status(TENANT, OP)).toEqual(
      sample.status.barrierOnly.response,
    );

    at(DONE_AT);
    expect(await service.destruction.apply(sample.lobehub.drainDone.request)).toEqual(
      sample.lobehub.drainDone.response,
    );
    expect(await service.destruction.status(TENANT, OP)).toEqual(sample.resume.statusAfterCrash);
  });

  it('answers unregister, its replay and the final status as sampled', async () => {
    const { at, repo, service } = setup();
    await service.receiveProvision(provision({ datasource: bundle(TENANT), tenantId: TENANT }));
    await service.executeProvision(TENANT, 'root-1:lobehub');
    repo.endpointRecords.add(TENANT);
    await service.destruction.apply(sample.lobehub.barrier.request);
    await service.destruction.apply(sample.lobehub.drainDone.request);
    at(DONE_AT);

    expect(await service.destruction.apply(sample.lobehub.unregister.request)).toEqual(
      sample.lobehub.unregister.response,
    );
    // Items come in the order unregisterItems.lobehub lists them.
    expect(sample.lobehub.unregister.response.items.map((i: any) => i.item)).toEqual(
      contract.unregisterItems.lobehub,
    );
    expect(await service.destruction.status(TENANT, OP)).toEqual(sample.status.complete.response);
    // Replay of the completed unregister: the shape of the sampled `absent` replay.
    expect(await service.destruction.apply(sample.lobehub.unregister.request)).toEqual(
      sample.admin.replayAfterCompletion.response,
    );
  });

  it('resumes a crashed unregister as sampled: only what is left is reported, then completes', async () => {
    const { at, repo, service } = setup();
    await service.receiveProvision(provision({ datasource: bundle(TENANT), tenantId: TENANT }));
    await service.executeProvision(TENANT, 'root-1:lobehub');
    repo.endpointRecords.add(TENANT);
    await service.destruction.apply(sample.lobehub.barrier.request);
    await service.destruction.apply(sample.lobehub.drainDone.request);
    // The first attempt got as far as the directory row.
    repo.directory.delete(TENANT);
    at(DONE_AT);
    expect(await service.destruction.status(TENANT, OP)).toEqual(sample.resume.statusAfterCrash);
    expect(await service.destruction.apply(sample.resume.repeatUnregister.request)).toEqual({
      ...sample.resume.repeatUnregister.response,
      items: sample.resume.repeatUnregister.response.items.map((item: any) =>
        // The sample deletes the credential bundle in the second attempt; here it left with the
        // directory row in the first, because both are one row.
        item.item === 'credential_bundle' || item.item === 'active_connection'
          ? { ...item, result: 'absent' }
          : item,
      ),
    });
  });

  it('refuses as sampled: operation conflict, destroyed provision, phase order', async () => {
    const { service } = setup();
    await expectCode(
      service.destruction.apply(sample.errors.phaseOrder.request),
      sample.errors.phaseOrder,
    );
    await service.destruction.apply(sample.lobehub.barrier.request);
    await expectCode(
      service.destruction.apply(sample.errors.conflict.request),
      sample.errors.conflict,
    );
    await expectCode(
      service.destruction.apply(sample.errors.phaseOrder.request),
      sample.errors.phaseOrder,
    );
    await expectCode(
      service.receiveProvision(provision({ datasource: bundle(TENANT), tenantId: TENANT })),
      sample.errors.destroyedProvision,
    );
  });

  it('emits only codes and statuses the contract lists, and lets them through to Console', () => {
    for (const [code, { http }] of Object.entries<any>(contract.errors.codes)) {
      if (
        ![
          'TENANT_DESTROYED',
          'DESTROY_PHASE_ORDER',
          'OPERATION_CONFLICT',
          'TENANT_DESTRUCTION_FAILED',
        ].includes(code)
      )
        continue;
      expect(SAFE_ERROR_CODES).toContain(code);
      expect(new ControlPlaneError(http, code as any).status).toBe(http);
    }
    expect(contract.errors.httpStatusByResultStatus).toEqual({
      absent: 200,
      applied: 200,
      applying: 202,
    });
  });
});

const expectCode = async (promise: Promise<unknown>, sampled: any) => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ControlPlaneError);
  expect(error).toMatchObject({ code: sampled.response.code, status: sampled.httpStatus });
};
