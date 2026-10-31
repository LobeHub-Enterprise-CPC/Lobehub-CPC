// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tryResumeParentFromAsyncTool } from './asyncTool';

const mocks = vi.hoisted(() => ({
  enabled: true,
  cas: vi.fn(),
  confirm: vi.fn(),
  schedule: vi.fn(),
}));
vi.mock('@/database/models/agentOperation', () => ({
  AgentOperationModel: class {
    tryResumeFromAsyncTool = mocks.cas;
    confirmAsyncToolResume = mocks.confirm;
  },
}));
vi.mock('@/server/services/gatewayAuthorization/operationAuthority', () => ({
  assertGatewayStateExecution: vi.fn(),
}));
vi.mock('@/server/modules/Hatchet/config', () => ({
  isHatchetDeliveryEnabled: () => mocks.enabled,
}));

const state = {
  status: 'waiting_for_async_tool',
  stepCount: 4,
  pendingToolsCalling: [{ id: 'tool' }],
};
const deps = {
  allPendingToolsFulfilled: vi.fn().mockResolvedValue(true),
  baseURL: 'http://localhost:3010/api/agent',
  coordinator: { loadAgentState: vi.fn().mockResolvedValue(state) },
  maybeScheduleAsyncToolVerify: vi.fn(),
  queueService: { scheduleMessage: mocks.schedule },
  resolveAsyncToolOnComplete: vi.fn().mockResolvedValue('resume'),
  serverDB: {},
  userId: 'user',
} as unknown as Parameters<typeof tryResumeParentFromAsyncTool>[0];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled = true;
  mocks.cas.mockResolvedValue(true);
  mocks.schedule.mockResolvedValue('message');
  mocks.confirm.mockResolvedValue(true);
});

describe('durable async-tool resume', () => {
  it('atomically records the resume payload and a fresh deduplication key with the CAS', async () => {
    await tryResumeParentFromAsyncTool(deps, {
      parentOperationId: 'parent',
      childOperationId: 'child',
    });
    expect(mocks.cas).toHaveBeenCalledWith(
      'parent',
      'child',
      expect.objectContaining({
        stepIndex: 4,
        payload: { resumeAsyncTool: true },
        deduplicationId: expect.any(String),
        createdAt: expect.any(String),
      }),
    );
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.objectContaining({
        deduplicationId: expect.any(String),
      }),
    );
  });
  it('leaves the existing non-Hatchet scheduling behavior unchanged', async () => {
    mocks.enabled = false;
    await tryResumeParentFromAsyncTool(deps, {
      parentOperationId: 'parent',
      childOperationId: 'child',
    });
    expect(mocks.cas).toHaveBeenCalledWith('parent', 'child');
    expect(mocks.schedule).toHaveBeenCalledWith(
      expect.not.objectContaining({ deduplicationId: expect.anything() }),
    );
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
});
