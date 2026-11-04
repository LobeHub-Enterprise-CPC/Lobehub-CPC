import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { serve } from '@/server/modules/Workflow';

import { hourlyWorkflowHandler, hourlyWorkflowOptions } from './workflows/hourly';
import { personaUpdateHandler, personaUpdateWorkflowOptions } from './workflows/personaUpdate';
import { processTopicHandler, processTopicWorkflowOptions } from './workflows/processTopic';
import { processTopicsHandler, processTopicsWorkflowOptions } from './workflows/processTopics';
import { processUsersHandler, processUsersWorkflowOptions } from './workflows/processUsers';
import {
  processUserTopicsHandler,
  processUserTopicsWorkflowOptions,
} from './workflows/processUserTopics';

const app = new Hono();

app.post(
  '/call-cron-hourly-analysis',
  serve(
    withOtelMetricsForUpstashWorkflows(hourlyWorkflowHandler, {
      url: '/api/workflows/memory-user-memory/call-cron-hourly-analysis',
    }),
    {
      ...hourlyWorkflowOptions,
    },
  ),
);

app.post(
  '/pipelines/persona/update-writing',
  serve(
    withOtelMetricsForUpstashWorkflows(personaUpdateHandler, {
      url: '/api/workflows/memory-user-memory/pipelines/persona/update-writing',
    }),
    personaUpdateWorkflowOptions,
  ),
);

app.post(
  '/pipelines/chat-topic/process-users',
  serve(
    withOtelMetricsForUpstashWorkflows(processUsersHandler, {
      url: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-users',
    }),
    {
      ...processUsersWorkflowOptions,
    },
  ),
);

app.post(
  '/pipelines/chat-topic/process-user-topics',
  serve(
    withOtelMetricsForUpstashWorkflows(processUserTopicsHandler, {
      url: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-user-topics',
    }),
    {
      ...processUserTopicsWorkflowOptions,
    },
  ),
);

app.post(
  '/pipelines/chat-topic/process-topics',
  serve(
    withOtelMetricsForUpstashWorkflows(processTopicsHandler, {
      url: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-topics',
    }),
    processTopicsWorkflowOptions,
  ),
);

app.post(
  '/pipelines/chat-topic/process-topic',
  serve(
    withOtelMetricsForUpstashWorkflows(processTopicHandler, {
      url: '/api/workflows/memory-user-memory/pipelines/chat-topic/process-topic',
    }),
    processTopicWorkflowOptions,
  ),
);

export default app;
