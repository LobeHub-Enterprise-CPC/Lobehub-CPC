// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  end: vi.fn().mockResolvedValue(undefined),
  migrate: vi.fn().mockResolvedValue(undefined),
  updateDirectory: vi.fn(() => ({ set: () => ({ where: vi.fn() }) })),
  upgrade: vi.fn(),
}));

// Replace only IO boundaries; run the real CLI entry and startup coordinator.
vi.mock('dotenv', () => ({ config: () => ({}) }));
vi.mock('dotenv-expand', () => ({ default: { expand: () => ({}) } }));
vi.mock('pg', () => ({
  Client: class {
    connect = async () => undefined;
    end = mocks.end;
    on = () => undefined;
    query = async () => ({ rows: [] });
  },
}));
vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => ({ update: mocks.updateDirectory }),
}));
vi.mock('drizzle-orm/node-postgres/migrator', () => ({ migrate: mocks.migrate }));
vi.mock('../../apps/server/src/services/tenantControlPlane/upgrade', () => ({
  upgradeTenantSchemas: mocks.upgrade,
}));
vi.mock('../../apps/server/src/services/tenantControlPlane/postgresExecutor', () => ({
  PostgresTenantDatabaseExecutor: class {},
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('migration CLI exit status', () => {
  const run = async (...args: string[]) => {
    vi.resetModules();
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'migrate', ...args]);
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/unused');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./index');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    return exit;
  };

  const failingTenant = () =>
    mocks.upgrade.mockResolvedValueOnce({
      failed: [{ reason: '42P01', tenantId: 'broken' }],
      migrated: ['healthy'],
    });

  it('exits non-zero when a tenant migration fails, after reporting every tenant', async () => {
    failingTenant();
    const exit = await run();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.updateDirectory).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'tenant_migration_unavailable',
        reason: '42P01',
        tenantId: 'broken',
      }),
    );
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'tenant_migration_summary', ready: 1, unavailable: 1 }),
    );
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('names the unavailable tenants on stderr so the failure is visible without the JSON log', async () => {
    failingTenant();
    await run();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('broken'));
  });

  it('boot mode tolerates failed tenants: exits 0, still reports them, writes no directory state', async () => {
    failingTenant();
    const exit = await run('--tolerate-tenant-failures');
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(mocks.updateDirectory).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ event: 'tenant_migration_summary', ready: 1, unavailable: 1 }),
    );
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it('exits successfully when every tenant migrates', async () => {
    mocks.upgrade.mockResolvedValueOnce({ failed: [], migrated: ['healthy'] });
    const exit = await run();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('exits with failure when the platform migration fails', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('platform failed'));
    const exit = await run();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
