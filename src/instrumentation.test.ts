// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./libs/debug-file-logger', () => ({}));

const mocks = vi.hoisted(() => ({
  probeMarketBindingForAllTenants: vi.fn(async () => undefined),
  serveWorkerHealth: vi.fn(async () => ({})),
  startHatchetPublisher: vi.fn(),
  startHatchetWorkers: vi.fn(() => ({ isServing: () => true })),
}));
vi.mock('@/server/modules/Hatchet/worker', () => ({
  startHatchetPublisher: mocks.startHatchetPublisher,
  startHatchetWorkers: mocks.startHatchetWorkers,
}));
vi.mock('@/server/modules/Hatchet/health', () => ({
  serveWorkerHealth: mocks.serveWorkerHealth,
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
    mocks.serveWorkerHealth.mockClear();
    mocks.startHatchetPublisher.mockClear();
    mocks.startHatchetWorkers.mockClear();
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

  describe('Hatchet workers', () => {
    it('consumes queue-mode deliveries by default', async () => {
      await registerWith({ AGENT_RUNTIME_MODE: 'queue', NEXT_RUNTIME: 'nodejs' });

      expect(mocks.startHatchetWorkers).toHaveBeenCalledOnce();
      expect(mocks.startHatchetPublisher).not.toHaveBeenCalled();
      expect(mocks.serveWorkerHealth).not.toHaveBeenCalled();
    });

    it('answers a worker health check when given a port (the executor readiness probe)', async () => {
      await registerWith({
        AGENT_RUNTIME_MODE: 'queue',
        HATCHET_WORKER_HEALTH_PORT: '3213',
        NEXT_RUNTIME: 'nodejs',
      });

      expect(mocks.serveWorkerHealth).toHaveBeenCalledOnce();
      const [port, ready] = mocks.serveWorkerHealth.mock.calls[0] as unknown as [
        number,
        () => boolean,
      ];
      expect(port).toBe(3213);
      expect(ready()).toBe(true);
      // Listening first: no worker exists before the readiness check does.
      expect(mocks.serveWorkerHealth.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.startHatchetWorkers.mock.invocationCallOrder[0],
      );
    });

    it('starts no worker when the health port cannot listen', async () => {
      mocks.serveWorkerHealth.mockRejectedValueOnce(new Error('EADDRINUSE'));

      await expect(
        registerWith({
          AGENT_RUNTIME_MODE: 'queue',
          HATCHET_WORKER_HEALTH_PORT: '3213',
          NEXT_RUNTIME: 'nodejs',
        }),
      ).rejects.toThrow('EADDRINUSE');
      expect(mocks.startHatchetWorkers).not.toHaveBeenCalled();
    });

    it('refuses an invalid health port instead of starting without a readiness check', async () => {
      await expect(
        registerWith({
          AGENT_RUNTIME_MODE: 'queue',
          HATCHET_WORKER_HEALTH_PORT: 'x',
          NEXT_RUNTIME: 'nodejs',
        }),
      ).rejects.toThrow('HATCHET_WORKER_HEALTH_PORT');
    });

    it('only publishes when the process is told not to consume (web pods beside an executor)', async () => {
      await registerWith({
        AGENT_RUNTIME_MODE: 'queue',
        HATCHET_WORKERS: 'off',
        NEXT_RUNTIME: 'nodejs',
      });

      expect(mocks.startHatchetWorkers).not.toHaveBeenCalled();
      // It still waits for its own publishes and post-response work on shutdown.
      expect(mocks.startHatchetPublisher).toHaveBeenCalledOnce();
    });

    it('refuses an unknown setting instead of silently consuming', async () => {
      await expect(
        registerWith({
          AGENT_RUNTIME_MODE: 'queue',
          HATCHET_WORKERS: 'false',
          NEXT_RUNTIME: 'nodejs',
        }),
      ).rejects.toThrow('HATCHET_WORKERS');
      expect(mocks.startHatchetWorkers).not.toHaveBeenCalled();
    });
  });
});
