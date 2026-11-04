import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { forEachTenant } from '@/server/modules/Tenant/fanOut';

import { getHatchetClient } from './client';
import { getDirectDeliveryClient } from './directDelivery';

/**
 * Deployment-wide recurring jobs (spec FR-AS-02). Each tick publishes one
 * delivery per available tenant to that tenant's handler under
 * `/api/workflows`, so the work itself always runs inside one admitted tenant.
 *
 * The goal sweep is not an optimization: a Goal Graph advances on events, so a
 * dropped delivery or a process that dies after dispatch would strand the goal
 * forever with nothing to notice. The sweep is what makes that recoverable.
 */
export const TENANT_SCHEDULES = {
  'goal-sweep': { cron: '*/5 * * * *', path: '/api/workflows/goal/sweep' },
  'task-schedule-dispatch': { cron: '*/10 * * * *', path: '/api/workflows/task/schedule-dispatch' },
  'widget-tick': { cron: '* * * * *', path: '/api/workflows/widget/tick' },
} as const;

export type TenantScheduleJob = keyof typeof TENANT_SCHEDULES;

/** Publishes one delivery of `job` per available tenant. */
export const fanOutTenantSchedule = async (job: TenantScheduleJob) => {
  // Server to server: the internal address skips the public ingress.
  const appUrl = process.env.INTERNAL_APP_URL || process.env.APP_URL;
  if (!appUrl) throw new Error('INTERNAL_APP_URL or APP_URL is required to fan out scheduled jobs');
  const { path } = TENANT_SCHEDULES[job];
  const { failed, succeeded } = await forEachTenant(`cron:${path}`, async () => {
    const { messageId } = await getDirectDeliveryClient().publishJSON({
      body: {},
      url: buildTenantCallbackUrl(path, appUrl),
    });
    return messageId;
  });
  return { failed: failed.length, published: succeeded.length };
};

/** Hatchet runs these on its own clock: one run per tick, whichever worker takes it. */
const declareScheduleTask = (job: TenantScheduleJob) =>
  getHatchetClient().task({
    executionTimeout: '5m',
    fn: async () => {
      const result = await fanOutTenantSchedule(job);
      // Nothing published means every tenant failed: let Hatchet record a failed run.
      if (result.published === 0 && result.failed > 0)
        throw new Error(`${job}: publishing failed for all ${result.failed} tenant(s)`);
      return result;
    },
    name: `cpc-cron-${job}`,
    onCrons: [TENANT_SCHEDULES[job].cron],
    retries: 1,
  });

let scheduleTasks: ReturnType<typeof declareScheduleTask>[] | undefined;

export const getScheduleTasks = () =>
  (scheduleTasks ??= (Object.keys(TENANT_SCHEDULES) as TenantScheduleJob[]).map(
    declareScheduleTask,
  ));
