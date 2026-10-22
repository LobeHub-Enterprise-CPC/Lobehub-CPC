import { beforeEach, describe, expect, it } from 'vitest';

import {
  assertConsoleInvariants,
  lifecycle,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';

let repo: ReturnType<typeof resetService>['repo'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ repo, service } = resetService());
});

describe('receiveLifecycle', () => {
  beforeEach(async () => {
    await provisionApplied();
  });

  it('is not found for a tenant LobeHub never saw', async () => {
    await expect(
      service.receiveLifecycle(lifecycle({ tenantId: 'stranger' })),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
  });

  it('accepts a new version and closes the gate in the same step', async () => {
    const result = await service.receiveLifecycle(lifecycle());
    expect(result).toMatchObject({ acceptedVersion: 1, appliedVersion: 0, status: 'received' });
    assertConsoleInvariants(result);
    expect(repo.lifecycles.get(TENANT)).toMatchObject({
      desiredState: 'frozen',
      freezeReasons: ['manual'],
    });
  });

  it('returns the stored record for an identical retry', async () => {
    const first = await service.receiveLifecycle(lifecycle());
    expect(await service.receiveLifecycle(lifecycle())).toEqual(first);
  });

  it('refuses a reused event id with different content', async () => {
    await service.receiveLifecycle(lifecycle());
    await expect(
      service.receiveLifecycle(lifecycle({ freezeReasons: ['security'] })),
    ).rejects.toMatchObject({ code: 'LIFECYCLE_EVENT_CONFLICT', status: 409 });
  });

  it('refuses a version another event already holds', async () => {
    await service.receiveLifecycle(lifecycle());
    await expect(service.receiveLifecycle(lifecycle({ eventId: 'evt-x' }))).rejects.toMatchObject({
      code: 'LIFECYCLE_VERSION_CONFLICT',
      status: 409,
    });
  });

  it('records an older version as superseded without touching state', async () => {
    await service.receiveLifecycle(lifecycle({ eventId: 'evt-2', version: 2 }));
    const late = await service.receiveLifecycle(
      lifecycle({ desiredState: 'active', eventId: 'evt-1', freezeReasons: [], version: 1 }),
    );
    expect(late.status).toBe('superseded');
    assertConsoleInvariants(late);
    expect(repo.lifecycles.get(TENANT)!.desiredState).toBe('frozen');
  });
});
