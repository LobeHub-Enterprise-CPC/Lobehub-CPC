import { getInternalApiUrl } from '@/envs/app';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';
import { type FlowControl, workflowClient } from '@/server/modules/Workflow';

import type { DispatchTopicAutoSummaryPayload, ExecuteTopicAutoSummaryPayload } from './types';

const DISPATCH_PATH = '/api/workflows/topic-auto-summary/dispatch';
const EXECUTE_PATH = '/api/workflows/topic-auto-summary/execute';

const getUrl = (path: string) => {
  const baseUrl = getInternalApiUrl();
  if (!baseUrl) throw new Error('APP_URL is required to trigger topic auto-summary workflows');
  return buildTenantCallbackUrl(path, baseUrl);
};

export class TopicAutoSummaryWorkflow {
  static triggerDispatch(payload: DispatchTopicAutoSummaryPayload) {
    return workflowClient.trigger({
      body: payload,
      flowControl: { key: 'topic-auto-summary.dispatch', parallelism: 1 } satisfies FlowControl,
      url: getUrl(DISPATCH_PATH),
    });
  }

  static triggerExecute(payload: ExecuteTopicAutoSummaryPayload) {
    return workflowClient.trigger({
      body: payload,
      flowControl: {
        key: `topic-auto-summary.execute.user.${payload.userId}`,
        parallelism: 2,
      } satisfies FlowControl,
      url: getUrl(EXECUTE_PATH),
    });
  }
}

export type { DispatchTopicAutoSummaryPayload, ExecuteTopicAutoSummaryPayload } from './types';
