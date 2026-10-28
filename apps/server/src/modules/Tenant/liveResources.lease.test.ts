// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TenantClaims } from './claims';
import { TenantGateError } from './errors';
import { TenantLiveResources } from './liveResources';

describe('resource reopen after a drain receipt', () => {
  it('rechecks authority after pinning and releases the pin when a delayed resume finds a stopped tenant', async () => {
    let admitted = true;
    const claims = new TenantClaims();
    const live = new TenantLiveResources(
      async () => {
        if (!admitted) throw new TenantGateError('TENANT_FROZEN');
      },
      60_000,
      undefined,
      undefined,
      claims,
    );
    const parent = await claims.enter('t');
    const resource = { close: vi.fn(), reopen: vi.fn() };
    const unbind = live.bind('t', resource);
    try {
      await parent();
      await live.suspend('t', new TenantGateError('TENANT_FROZEN'));
      expect(claims.isHeld('t')).toBe(false);
      admitted = false;
      await expect(live.resume('t')).rejects.toThrow('TENANT_LIVE_RESOURCE_REOPEN_FAILED');
      expect(resource.reopen).not.toHaveBeenCalled();
      expect(claims.isHeld('t')).toBe(false);
    } finally {
      unbind();
      await parent();
    }
  });
});
