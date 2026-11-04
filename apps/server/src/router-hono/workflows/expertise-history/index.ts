import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { serve } from '@/server/modules/Workflow';
import { runExpertiseHistoryWorkflow } from '@/server/workflows/expertiseHistory';
import { runExpertiseHistoryTopicWorkflow } from '@/server/workflows/expertiseHistory/topic';

const app = new Hono();

app.post(
  '/run',
  serve(
    withOtelMetricsForUpstashWorkflows(runExpertiseHistoryWorkflow, {
      url: '/api/workflows/expertise-history/run',
    }),
  ),
);

app.post(
  '/topic',
  serve(
    withOtelMetricsForUpstashWorkflows(runExpertiseHistoryTopicWorkflow, {
      url: '/api/workflows/expertise-history/topic',
    }),
  ),
);

export default app;
