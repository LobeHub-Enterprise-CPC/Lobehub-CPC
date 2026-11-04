import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { serve } from '@/server/modules/Workflow';

import { dispatchTopicAutoSummary, dispatchTopicAutoSummaryOptions } from './dispatch';
import { executeTopicAutoSummary, executeTopicAutoSummaryOptions } from './execute';

const app = new Hono();

app.post(
  '/dispatch',
  serve(
    withOtelMetricsForUpstashWorkflows(dispatchTopicAutoSummary, {
      url: '/api/workflows/topic-auto-summary/dispatch',
    }),
    dispatchTopicAutoSummaryOptions,
  ),
);

app.post(
  '/execute',
  serve(
    withOtelMetricsForUpstashWorkflows(executeTopicAutoSummary, {
      url: '/api/workflows/topic-auto-summary/execute',
    }),
    executeTopicAutoSummaryOptions,
  ),
);

export default app;
