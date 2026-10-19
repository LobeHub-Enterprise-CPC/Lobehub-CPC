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
  const run = async () => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgresql://test:test@127.0.0.1:1/unused');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await import('./index');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    return exit;
  };

  it('exits successfully without writing tenantDirectory when a tenant migration fails', async () => {
    mocks.upgrade.mockResolvedValueOnce({
      failed: [{ reason: '42P01', tenantId: 'broken' }],
      migrated: ['healthy'],
    });
    const exit = await run();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
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

  it('exits with failure when the platform migration fails', async () => {
    mocks.migrate.mockRejectedValueOnce(new Error('platform failed'));
    const exit = await run();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(mocks.upgrade).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
