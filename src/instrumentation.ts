export async function register() {
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

  // Note: messenger system bot connections (Discord/Telegram) are managed
  // entirely from dc-center's System Bots admin — save / enable / forceReconnect
  // mutations call MessageGateway directly. The main app's only role here is
  // to receive forwarded events at `/api/agent/messenger/webhooks/<platform>`,
  // which doesn't require any startup work.

  if (process.env.NODE_ENV !== 'production' && !process.env.ENABLE_TELEMETRY_IN_DEV) {
    return;
  }

  const shouldEnable = process.env.ENABLE_TELEMETRY && process.env.NEXT_RUNTIME === 'nodejs';
  if (!shouldEnable) {
    return;
  }

  await import('./instrumentation.node');
}
