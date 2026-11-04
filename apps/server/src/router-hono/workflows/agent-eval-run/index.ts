import { withOtelMetricsForUpstashWorkflows } from '@lobechat/observability-otel/modules/upstash-workflow';
import { Hono } from 'hono';

import { serve } from '@/server/modules/Workflow';

import { onThreadComplete } from './handlers/onThreadComplete';
import { onTrajectoryComplete } from './handlers/onTrajectoryComplete';
import {
  executeTestCaseHandler,
  executeTestCaseWorkflowOptions,
} from './workflows/executeTestCase';
import { finalizeRunHandler, finalizeRunWorkflowOptions } from './workflows/finalizeRun';
import {
  paginateTestCasesHandler,
  paginateTestCasesWorkflowOptions,
} from './workflows/paginateTestCases';
import {
  resumeAgentTrajectoryHandler,
  resumeAgentTrajectoryWorkflowOptions,
} from './workflows/resumeAgentTrajectory';
import {
  resumeThreadTrajectoryHandler,
  resumeThreadTrajectoryWorkflowOptions,
} from './workflows/resumeThreadTrajectory';
import {
  runAgentTrajectoryHandler,
  runAgentTrajectoryWorkflowOptions,
} from './workflows/runAgentTrajectory';
import { runBenchmarkHandler, runBenchmarkWorkflowOptions } from './workflows/runBenchmark';
import {
  runThreadTrajectoryHandler,
  runThreadTrajectoryWorkflowOptions,
} from './workflows/runThreadTrajectory';

const app = new Hono();

app.post(
  '/run-benchmark',
  serve(
    withOtelMetricsForUpstashWorkflows(runBenchmarkHandler, {
      url: '/api/workflows/agent-eval-run/run-benchmark',
    }),
    runBenchmarkWorkflowOptions,
  ),
);

app.post(
  '/paginate-test-cases',
  serve(
    withOtelMetricsForUpstashWorkflows(paginateTestCasesHandler, {
      url: '/api/workflows/agent-eval-run/paginate-test-cases',
    }),
    paginateTestCasesWorkflowOptions,
  ),
);

app.post(
  '/execute-test-case',
  serve(
    withOtelMetricsForUpstashWorkflows(executeTestCaseHandler, {
      url: '/api/workflows/agent-eval-run/execute-test-case',
    }),
    executeTestCaseWorkflowOptions,
  ),
);

app.post(
  '/run-agent-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(runAgentTrajectoryHandler, {
      url: '/api/workflows/agent-eval-run/run-agent-trajectory',
    }),
    runAgentTrajectoryWorkflowOptions,
  ),
);

app.post(
  '/run-thread-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(runThreadTrajectoryHandler, {
      url: '/api/workflows/agent-eval-run/run-thread-trajectory',
    }),
    runThreadTrajectoryWorkflowOptions,
  ),
);

app.post(
  '/resume-agent-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(resumeAgentTrajectoryHandler, {
      url: '/api/workflows/agent-eval-run/resume-agent-trajectory',
    }),
    resumeAgentTrajectoryWorkflowOptions,
  ),
);

app.post(
  '/resume-thread-trajectory',
  serve(
    withOtelMetricsForUpstashWorkflows(resumeThreadTrajectoryHandler, {
      url: '/api/workflows/agent-eval-run/resume-thread-trajectory',
    }),
    resumeThreadTrajectoryWorkflowOptions,
  ),
);

app.post(
  '/finalize-run',
  serve(
    withOtelMetricsForUpstashWorkflows(finalizeRunHandler, {
      url: '/api/workflows/agent-eval-run/finalize-run',
    }),
    finalizeRunWorkflowOptions,
  ),
);

// Plain completion webhooks posted by AgentRuntimeService — not Upstash workflows.
app.post('/on-trajectory-complete', onTrajectoryComplete);
app.post('/on-thread-complete', onThreadComplete);

export default app;
