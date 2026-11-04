import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { serve } from '@/server/modules/Workflow';
import { runExpertiseRejectionWorkflow } from '@/server/workflows/expertiseRejection';

const app = new Hono();

app.post(
  '/run',
  serve(
    withOtelMetricsForUpstashWorkflows(runExpertiseRejectionWorkflow, {
      url: '/api/workflows/expertise-rejection/run',
    }),
  ),
);

export default app;
