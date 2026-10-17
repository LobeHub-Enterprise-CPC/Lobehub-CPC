import { describe, expect, it, vi } from 'vitest';

import {
  type FtsSearchSyncCaptureRepository,
  type FtsSearchSyncCaptureTenant,
  installFtsSearchSyncCapture,
  runFtsSearchSyncCaptureCli,
} from './index';

const createRepository = (): FtsSearchSyncCaptureRepository => ({
  installCaptureInfrastructure: vi.fn().mockResolvedValue(undefined),
});

const tenant = (tenantId: string, repository = createRepository()) => {
  const close = vi.fn().mockResolvedValue(undefined);
  const entry: FtsSearchSyncCaptureTenant = {
    open: vi.fn().mockResolvedValue({ close, repository }),
    tenantId,
  };
  return { close, entry, repository };
};

const runWithLockRetry = () => vi.fn(async (operation: () => Promise<void>) => operation());

describe('installFtsSearchSyncCapture', () => {
  it('installs capture in every tenant schema, one connection per tenant', async () => {
    const a = tenant('tenant-a');
    const b = tenant('tenant-b');
    const retry = runWithLockRetry();

    await expect(
      installFtsSearchSyncCapture({
        env: { DATABASE_URL: 'postgres://platform' },
        listTenants: vi.fn().mockResolvedValue([a.entry, b.entry]),
        runWithLockRetry: retry,
      }),
    ).resolves.toEqual(['tenant-a', 'tenant-b']);

    expect(retry).toHaveBeenCalledTimes(2);
    for (const { close, repository } of [a, b]) {
      expect(repository.installCaptureInfrastructure).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('keeps going past a failing tenant and then fails naming it', async () => {
    const failing = tenant('tenant-a', {
      installCaptureInfrastructure: vi.fn().mockRejectedValue(new Error('definition mismatch')),
    });
    const healthy = tenant('tenant-b');

    await expect(
      installFtsSearchSyncCapture({
        env: { DATABASE_URL: 'postgres://platform' },
        listTenants: vi.fn().mockResolvedValue([failing.entry, healthy.entry]),
        runWithLockRetry: runWithLockRetry(),
      }),
    ).rejects.toThrow('capture installation failed for tenants tenant-a');

    expect(failing.close).toHaveBeenCalledOnce();
    expect(healthy.repository.installCaptureInfrastructure).toHaveBeenCalledOnce();
  });

  it('fails before reading the tenant directory when DATABASE_URL is missing', async () => {
    const listTenants = vi.fn();

    await expect(installFtsSearchSyncCapture({ env: {}, listTenants })).rejects.toThrow(
      'DATABASE_URL is required',
    );

    expect(listTenants).not.toHaveBeenCalled();
  });
});

describe('runFtsSearchSyncCaptureCli', () => {
  it('returns success and logs only after capture installation succeeds', async () => {
    const logError = vi.fn();
    const logSuccess = vi.fn();

    await expect(
      runFtsSearchSyncCaptureCli({
        env: { DATABASE_URL: 'postgres://platform' },
        listTenants: vi.fn().mockResolvedValue([tenant('tenant-a').entry]),
        logError,
        logSuccess,
        runWithLockRetry: runWithLockRetry(),
      }),
    ).resolves.toBe(0);

    expect(logSuccess).toHaveBeenCalledWith(
      '✅ full-text search sync capture infrastructure installed in %d tenant(s)',
      1,
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('returns failure and does not report success when capture installation fails', async () => {
    const error = new Error(
      'capture installation failed at https://operator:private@database.example.com/app?query=private token=private-token',
    );
    const logError = vi.fn();
    const logSuccess = vi.fn();

    await expect(
      runFtsSearchSyncCaptureCli({
        env: { DATABASE_URL: 'postgres://platform' },
        listTenants: vi
          .fn()
          .mockResolvedValue([
            tenant('tenant-a', { installCaptureInfrastructure: vi.fn().mockRejectedValue(error) })
              .entry,
          ]),
        logError,
        logSuccess,
        runWithLockRetry: runWithLockRetry(),
      }),
    ).resolves.toBe(1);

    expect(logError).toHaveBeenCalledWith(
      '❌ Full-text search sync capture installation failed:',
      'capture installation failed for tenants tenant-a',
    );
    expect(logError).toHaveBeenCalledWith(
      'First failure:',
      'capture installation failed at [redacted-url] token=[redacted]',
    );
    expect(logSuccess).not.toHaveBeenCalled();
  });
});
