import type { Context } from 'hono';
import { Hono } from 'hono';

import { qstashClient } from '@/libs/qstash';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';
import { startGatewayForAllTenants } from '@/server/services/gateway/tenantStart';

import { bearerSecretAuth } from '../agent/middlewares/bearerSecretAuth';
import { qstashAuth } from '../agent/middlewares/qstashAuth';

/**
 * Deployment-wide schedules (spec FR-AS-02). These are the only business
 * entry points without a tenant: each one enumerates the available tenants
 * and hands the work to every tenant separately, so the work itself always
 * runs inside one admitted tenant.
 */
const app = new Hono().basePath('/api/cron');

/**
 * Recurring QStash schedules whose per-tenant handler lives under
 * `/api/workflows`. The fan-out publishes one signed QStash message per tenant
 * to that tenant's address instead of running every tenant in this request.
 */
const TENANT_SCHEDULES: Record<string, string> = {
  'goal-sweep': '/api/workflows/goal/sweep',
  'task-schedule-dispatch': '/api/workflows/task/schedule-dispatch',
};

const fanOutSchedule = async (c: Context) => {
  const target = TENANT_SCHEDULES[c.req.param('job') ?? ''];
  if (!target) return c.json({ error: 'Unknown schedule' }, 404);
  if (!process.env.APP_URL) return c.json({ error: 'APP_URL is not configured' }, 503);

  const body = await c.req.json().catch(() => ({}));
  const { failed, succeeded } = await forEachTenant(`cron:${target}`, async () => {
    const response = await qstashClient.publishJSON({
      body,
      url: buildTenantCallbackUrl(target, process.env.APP_URL),
    });
    return 'messageId' in response ? response.messageId : '';
  });
  return c.json({ failed, published: succeeded.length });
};

// POST /api/cron/:job — QStash schedule entry (signature required).
app.post('/:job', qstashAuth(), fanOutSchedule);

// POST /api/cron/gateway/start — standalone launcher (Bearer KEY_VAULTS_SECRET).
app.post(
  '/gateway/start',
  bearerSecretAuth(() => process.env.KEY_VAULTS_SECRET),
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { restart?: boolean };
    return c.json(await startGatewayForAllTenants({ restart: body.restart }));
  },
);

export default app;
