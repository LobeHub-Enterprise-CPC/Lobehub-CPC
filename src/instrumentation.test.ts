// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./libs/debug-file-logger', () => ({}));

const mocks = vi.hoisted(() => ({
  probeMarketBindingForAllTenants: vi.fn(async () => undefined),
}));
vi.mock('@/server/services/market/bindingProbe', () => ({
  probeMarketBindingForAllTenants: mocks.probeMarketBindingForAllTenants,
}));
vi.mock('@/server/services/gateway/tenantStart', () => ({
  startGatewayForAllTenants: vi.fn(async () => undefined),
}));
vi.mock('@/business/server/agent-transfer/jobRunner', () => ({
  resumePendingAgentTransferJobs: vi.fn(async () => undefined),
}));
vi.mock('@/server/modules/Tenant/fanOut', () => ({ forEachTenant: vi.fn(async () => undefined) }));

const registerWith = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { register } = await import('./instrumentation');
  return register();
};

describe('instrumentation register', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.probeMarketBindingForAllTenants.mockClear();
  });

  it('refuses to start when the agent and device gateway service tokens are equal', async () => {
    await expect(
      registerWith({
        AGENT_GATEWAY_SERVICE_TOKEN: 'same',
        DEVICE_GATEWAY_SERVICE_TOKEN: 'same',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).rejects.toThrow('DEVICE_GATEWAY_SERVICE_TOKEN');
  });

  it('starts with distinct tokens', async () => {
    await expect(
      registerWith({
        AGENT_GATEWAY_SERVICE_TOKEN: 'agent',
        DEVICE_GATEWAY_SERVICE_TOKEN: 'device',
        NEXT_RUNTIME: 'nodejs',
      }),
    ).resolves.toBeUndefined();
  });

  it('checks the Market trusted-client bindings in the background once a database is configured', async () => {
    await registerWith({ DATABASE_URL: 'postgres://unused', NEXT_RUNTIME: 'nodejs' });

    await vi.waitFor(() => expect(mocks.probeMarketBindingForAllTenants).toHaveBeenCalledOnce());
  });

  it('does not check bindings without a database, or outside the Node runtime', async () => {
    await registerWith({ NEXT_RUNTIME: 'nodejs' });
    await registerWith({ DATABASE_URL: 'postgres://unused', NEXT_RUNTIME: 'edge' });

    expect(mocks.probeMarketBindingForAllTenants).not.toHaveBeenCalled();
  });

  it('keeps starting when the binding check itself fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.probeMarketBindingForAllTenants.mockRejectedValueOnce(new Error('platform db down'));

    await expect(
      registerWith({ DATABASE_URL: 'postgres://unused', NEXT_RUNTIME: 'nodejs' }),
    ).resolves.toBeUndefined();

    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('Market trusted-client bindings'),
        expect.any(Error),
      ),
    );
    error.mockRestore();
  });
});
