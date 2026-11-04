import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { createWorkflow, serveMany } from '@/server/modules/Workflow';
import type { ProcessOnboardingTaskRecommendationPayload } from '@/server/workflows/onboardingTaskRecommendation';
import {
  processOnboardingTaskRecommendations,
  processOnboardingTaskRecommendationWorkflowOptions,
} from '@/server/workflows/onboardingTaskRecommendation/process';

const app = new Hono();

/**
 * Serves the durable workflow that collects connector evidence and generates onboarding tasks.
 *
 * Use when:
 * - QStash invokes or resumes recommendation generation
 *
 * Expects:
 * - A workflow payload for the current Understanding session
 *
 * Returns:
 * - A terminal recommendation session after all provider branches settle
 */
export const processTaskRecommendationsWorkflow = createWorkflow<
  ProcessOnboardingTaskRecommendationPayload,
  Awaited<ReturnType<typeof processOnboardingTaskRecommendations>>
>(
  withOtelMetricsForUpstashWorkflows(processOnboardingTaskRecommendations, {
    url: '/api/workflows/onboarding/task-recommendations/process',
  }),
  processOnboardingTaskRecommendationWorkflowOptions,
);

app.post('/:workflowId', serveMany({ process: processTaskRecommendationsWorkflow }));

export default app;
