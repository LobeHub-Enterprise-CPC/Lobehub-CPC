import { verifyPassword } from 'better-auth/crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  bundle,
  lifecycle,
  provisionApplied,
  resetService,
  TENANT,
} from './__tests__/service.testUtils';

let db: ReturnType<typeof resetService>['db'];
let service: ReturnType<typeof resetService>['service'];
beforeEach(() => {
  ({ db, service } = resetService());
});

const bootstrapOwner = { email: 'owner@acme.com', name: 'Owner', password: 'Aa1!aaaaaaaa' };

describe('syncBootstrapOwner', () => {
  it('gives the provisioned tenant’s initial account the Owner, keeping only its hash', async () => {
    await provisionApplied();

    const result = await service.syncBootstrapOwner({ bootstrapOwner, tenantId: TENANT });

    expect(result).toEqual({ bootstrapOwnerReady: true, tenantId: TENANT });
    expect(db.syncBootstrapOwner).toHaveBeenCalledTimes(1);
    const [{ bundle: used, owner, tenantId }] = db.syncBootstrapOwner.mock.calls[0];
    expect(used).toEqual(bundle());
    expect(tenantId).toBe(TENANT);
    expect(owner).toMatchObject({ email: 'owner@acme.com', name: 'Owner' });
    expect(owner.passwordHash).not.toContain(bootstrapOwner.password);
    expect(
      await verifyPassword({ hash: owner.passwordHash, password: bootstrapOwner.password }),
    ).toBe(true);
  });

  it('refuses a tenant that is not provisioned', async () => {
    await expect(
      service.syncBootstrapOwner({ bootstrapOwner, tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'TENANT_NOT_FOUND', status: 404 });
    expect(db.syncBootstrapOwner).not.toHaveBeenCalled();
  });

  it('refuses once the tenant has been opened: the Owner is no longer Console’s to replace', async () => {
    await provisionApplied();
    await service.receiveLifecycle(lifecycle({ desiredState: 'active', freezeReasons: [] }));

    await expect(
      service.syncBootstrapOwner({ bootstrapOwner, tenantId: TENANT }),
    ).rejects.toMatchObject({ code: 'TENANT_INVALID', status: 409 });
    expect(db.syncBootstrapOwner).not.toHaveBeenCalled();
  });

  it('still takes the Owner while the tenant is frozen or offline before it opened', async () => {
    await provisionApplied();
    await service.receiveLifecycle(lifecycle());

    await expect(
      service.syncBootstrapOwner({ bootstrapOwner, tenantId: TENANT }),
    ).resolves.toMatchObject({ bootstrapOwnerReady: true });
  });
});
