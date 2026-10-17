import { getInternalApiUrl } from '@/envs/app';
import { injectActiveTraceHeaders } from '@/libs/observability/traceparent';
import { workflowClient } from '@/libs/qstash';
import { buildTenantCallbackUrl } from '@/server/modules/Tenant/callbackUrl';

import {
  type ProcessCollectedUnderstandingPayload,
  ProcessCollectedUnderstandingPayloadSchema,
  type ProcessUnderstandingProvidersPayload,
  ProcessUnderstandingProvidersPayloadSchema,
} from './types';

export type {
  ProcessCollectedUnderstandingPayload,
  ProcessUnderstandingProvidersPayload,
} from './types';

const PROCESS_PROVIDERS_PATH = '/api/workflows/onboarding/understanding/process-providers';
const PROCESS_COLLECTED_PATH = '/api/workflows/onboarding/understanding/process-collected';
const PROCESS_DETAILED_PERSONA_PATH =
  '/api/workflows/onboarding/understanding/process-detailed-persona';

export class UnderstandingWorkflowUnavailableError extends Error {
  readonly code = 'ONBOARDING_UNDERSTANDING_WORKFLOW_UNAVAILABLE';

  constructor() {
    super('Onboarding understanding workflow is unavailable');
    this.name = 'UnderstandingWorkflowUnavailableError';
  }
}

export class OnboardingUnderstandingWorkflow {
  static assertAvailable() {
    const baseUrl = getInternalApiUrl();
    if (!process.env.QSTASH_TOKEN || !baseUrl) {
      throw new UnderstandingWorkflowUnavailableError();
    }
    return baseUrl;
  }

  static async triggerProviders(
    input: ProcessUnderstandingProvidersPayload,
    options?: { workflowRunId?: string },
  ) {
    const baseUrl = this.assertAvailable();
    const parsed = ProcessUnderstandingProvidersPayloadSchema.parse(input);
    const payload = {
      ...parsed,
      providers: parsed.providers.toSorted((left, right) => left.id.localeCompare(right.id)),
    };
    const traceHeaders = new Headers();
    injectActiveTraceHeaders(traceHeaders);

    return workflowClient.trigger({
      body: payload,
      headers: Object.fromEntries(traceHeaders.entries()),
      url: buildTenantCallbackUrl(PROCESS_PROVIDERS_PATH, baseUrl),
      ...(options?.workflowRunId ? { workflowRunId: options.workflowRunId } : {}),
    });
  }

  static async triggerWriting(
    input: ProcessCollectedUnderstandingPayload,
    options?: { workflowRunId?: string },
  ) {
    const baseUrl = this.assertAvailable();
    const payload = ProcessCollectedUnderstandingPayloadSchema.parse(input);
    const traceHeaders = new Headers();
    injectActiveTraceHeaders(traceHeaders);

    return workflowClient.trigger({
      body: payload,
      headers: Object.fromEntries(traceHeaders.entries()),
      url: buildTenantCallbackUrl(PROCESS_COLLECTED_PATH, baseUrl),
      ...(options?.workflowRunId ? { workflowRunId: options.workflowRunId } : {}),
    });
  }

  static async triggerDetailedPersona(
    input: ProcessCollectedUnderstandingPayload,
    options?: { workflowRunId?: string },
  ) {
    const baseUrl = this.assertAvailable();
    const payload = ProcessCollectedUnderstandingPayloadSchema.parse(input);
    const traceHeaders = new Headers();
    injectActiveTraceHeaders(traceHeaders);

    return workflowClient.trigger({
      body: payload,
      headers: Object.fromEntries(traceHeaders.entries()),
      url: buildTenantCallbackUrl(PROCESS_DETAILED_PERSONA_PATH, baseUrl),
      ...(options?.workflowRunId ? { workflowRunId: options.workflowRunId } : {}),
    });
  }
}
