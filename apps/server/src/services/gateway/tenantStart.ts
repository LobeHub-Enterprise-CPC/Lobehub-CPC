import debug from 'debug';

import { forEachTenant } from '@/server/modules/Tenant/fanOut';

import { GatewayService } from './index';

const log = debug('lobe-server:bot-gateway');

/**
 * Starts the in-process bot gateway for every tenant (standalone launcher and
 * server startup). Each tenant gets its own gateway manager, created inside
 * the tenant so its bot connections and callbacks stay in that tenant.
 *
 * With the external message gateway, each tenant's reconcile treats the
 * connections it does not own as stale and disconnects them, so a per-tenant
 * sync would tear down other tenants' bots; that mode is refused here until
 * connections carry their tenant.
 */
export const startGatewayForAllTenants = async (options: { restart?: boolean } = {}) => {
  const service = new GatewayService();
  if (service.useMessageGateway) {
    log('gateway start skipped: the external message gateway is not tenant-aware yet');
    return { skipped: 'message-gateway' as const };
  }
  const result = await forEachTenant('gateway:start', async () => {
    if (options.restart) await service.stop();
    await service.ensureRunning();
  });
  return { failed: result.failed, started: result.succeeded.length };
};
