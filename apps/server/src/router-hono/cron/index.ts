import { Hono } from 'hono';

import { startGatewayForAllTenants } from '@/server/services/gateway/tenantStart';

import { bearerSecretAuth } from '../agent/middlewares/bearerSecretAuth';
import { reapOperationsForAllTenants } from './reapOperations';

/**
 * Deployment-wide entry points without a tenant (spec FR-AS-02): each one
 * enumerates the available tenants and hands the work to every tenant
 * separately. Recurring per-tenant jobs run from Hatchet crons instead
 * (`@/server/modules/Hatchet/schedules`).
 */
const app = new Hono().basePath('/api/cron');

// POST /api/cron/gateway/start — standalone launcher (Bearer KEY_VAULTS_SECRET).
app.post(
  '/gateway/start',
  bearerSecretAuth(() => process.env.KEY_VAULTS_SECRET),
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { restart?: boolean };
    return c.json(await startGatewayForAllTenants({ restart: body.restart }));
  },
);

// POST /api/cron/agent/reap-operations — stale-operation recovery for every
// tenant (Bearer CRON_SECRET), called by the deployment's scheduler.
app.post(
  '/agent/reap-operations',
  bearerSecretAuth(() => process.env.CRON_SECRET),
  reapOperationsForAllTenants,
);

export default app;
