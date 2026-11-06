export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertDistinctGatewayServiceTokens } = await import('@lobechat/env/gateway');
    assertDistinctGatewayServiceTokens();
  }

  // In local development, write debug logs to logs/server.log
  if (process.env.NODE_ENV !== 'production' && process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./libs/debug-file-logger');
  }

  // Auto-start GatewayManager on server start for non-Vercel environments (Docker, local).
  // Persistent bots need reconnection after restart.
  // On Vercel, the cron job at /api/agent/gateway handles this reliably instead.
  // In local dev, opt-in via ENABLE_BOT_IN_DEV to avoid clobbering a shared bot binding.
  const isDev = process.env.NODE_ENV !== 'production';
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.DATABASE_URL &&
    !process.env.VERCEL_ENV &&
    (!isDev || process.env.ENABLE_BOT_IN_DEV === '1')
  ) {
    // Bots belong to tenants: start each tenant's gateway inside that tenant.
    const { startGatewayForAllTenants } = await import('@/server/services/gateway/tenantStart');
    startGatewayForAllTenants().catch((err) => {
      console.error('[Instrumentation] Failed to auto-start GatewayManager:', err);
    });
  }

  // Resume agent-transfer history backfills interrupted by a restart. The
  // default in-process job driver loses its in-memory running set on restart,
  // so re-arm every pending job at boot. Serverless (Vercel) deployments use
  // a durable-queue driver instead and don't need this hook.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.DATABASE_URL &&
    !process.env.VERCEL_ENV
  ) {
    void (async () => {
      const [{ getServerDB }, { resumePendingAgentTransferJobs }, { forEachTenant }] =
        await Promise.all([
          import('@lobechat/database'),
          import('@/business/server/agent-transfer/jobRunner'),
          import('@/server/modules/Tenant/fanOut'),
        ]);
      // Each tenant's pending jobs live in its own schema.
      await forEachTenant('agent-transfer:resume', async () =>
        resumePendingAgentTransferJobs(await getServerDB()),
      );
    })().catch((err) => {
      console.error('[Instrumentation] Failed to resume agent-transfer jobs:', err);
    });
  }

  // Warn at startup about tenants whose Market trusted client is not usable (not bound to the
  // tenant's instance, wrong secret, instance frozen), instead of letting the first user request
  // fail as an anonymous 401. Background and warn-only: Market never gates a tenant or the process.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.DATABASE_URL &&
    !process.env.VERCEL_ENV
  ) {
    void import('@/server/services/market/bindingProbe')
      .then(({ probeMarketBindingForAllTenants }) => probeMarketBindingForAllTenants())
      .catch((err) => {
        console.error('[Instrumentation] Failed to check Market trusted-client bindings:', err);
      });
  }

  // Queue-mode agent deliveries through Hatchet: this process runs the workers
  // that hand each delivery to its own routes, unless it is a web pod beside a
  // separate executor (`HATCHET_WORKERS=off`), which only publishes but still
  // waits for its publishes and post-response work on shutdown. Started in the
  // background — the workers wait until this server answers on its loopback
  // address; the executor's readiness probe asks the worker health port.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { getHatchetWorkerHealthPort, isHatchetDeliveryEnabled, isHatchetWorkerProcess } =
      await import('@/server/modules/Hatchet/config');
    if (isHatchetDeliveryEnabled()) {
      const consume = isHatchetWorkerProcess();
      const healthPort = getHatchetWorkerHealthPort();
      const { startHatchetPublisher, startHatchetWorkers } =
        await import('@/server/modules/Hatchet/worker');
      if (consume) {
        // The health port listens before any worker exists: if it cannot, start fails
        // here, before this process has taken (paid) work it would then have to abandon.
        let serving = () => false;
        if (healthPort !== undefined) {
          const { serveWorkerHealth } = await import('@/server/modules/Hatchet/health');
          await serveWorkerHealth(healthPort, () => serving());
        }
        serving = startHatchetWorkers().isServing;
      } else {
        startHatchetPublisher();
      }
    }
  }

  // Note: messenger system bot connections (Discord/Telegram) are managed
  // entirely from dc-center's System Bots admin — save / enable / forceReconnect
  // mutations call MessageGateway directly. The main app's only role here is
  // to receive forwarded events at `/api/agent/messenger/webhooks/<platform>`,
  // which doesn't require any startup work.

  // Name the work behind a blocked event loop. A long enough stall outlasts the tenant process
  // lease and the server fences itself; without this the restart is all that is left behind.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startStallDetector } = await import('@/server/modules/RuntimeActivity');
    startStallDetector();
  }

  if (process.env.NODE_ENV !== 'production' && !process.env.ENABLE_TELEMETRY_IN_DEV) {
    return;
  }

  const shouldEnable = process.env.ENABLE_TELEMETRY && process.env.NEXT_RUNTIME === 'nodejs';
  if (!shouldEnable) {
    return;
  }

  await import('./instrumentation.node');
}
