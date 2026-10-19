import { runWithTenantScope, type TenantScope } from '@lobechat/database/tenant';
import { describe, expect, it, vi } from 'vitest';

import { TrackedPlatformClient } from './TrackedPlatformClient';

describe('tracked bot listener lifecycle', () => {
  it('retains the tenant work pin through failed teardown and releases it after a successful retry', async () => {
    const release = vi.fn();
    const trackWork = vi.fn(() => release);
    const scope = { tenantId: 'test', trackWork } as unknown as TenantScope;
    const lifecycle = new TrackedPlatformClient();
    await runWithTenantScope(scope, () =>
      lifecycle.start(
        async () => {},
        async () => {},
      ),
    );
    expect(trackWork).toHaveBeenCalledOnce();
    await expect(
      lifecycle.stop(async () => {
        throw new Error('stop failed');
      }),
    ).rejects.toThrow('stop failed');
    expect(release).not.toHaveBeenCalled();
    await lifecycle.stop(async () => {});
    expect(release).toHaveBeenCalledOnce();
  });

  it('merges concurrent starts and rejects a new start while teardown waits for startup', async () => {
    const lifecycle = new TrackedPlatformClient();
    const starting = Promise.withResolvers<void>();
    const start = vi.fn(() => starting.promise);
    const first = lifecycle.start(start, async () => {});
    const second = lifecycle.start(start, async () => {});
    expect(start).toHaveBeenCalledOnce();
    const stop = vi.fn(async () => {
      await lifecycle.waitForStart();
    });
    const closing = lifecycle.stop(stop);
    await expect(lifecycle.start(start, async () => {})).rejects.toThrow('BOT_STOP_IN_PROGRESS');
    starting.resolve();
    await Promise.all([first, second, closing]);
    expect(stop).toHaveBeenCalledOnce();
  });
});
