// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { InterventionController } from './InterventionController';

vi.mock('@/server/services/deviceGateway', () => ({ deviceGateway: {} }));

const OPERATION_ID = 'op-parked';

const setUp = (status: string) => {
  const agentRuntimeService = {
    interruptOperation: vi.fn().mockResolvedValue(true),
    removeTracePartial: vi.fn().mockResolvedValue(undefined),
  };
  const agentOperationModel = {
    findById: vi.fn().mockResolvedValue({ id: OPERATION_ID, status }),
    recordCompletion: vi.fn().mockResolvedValue(true),
  };
  const controller = new InterventionController({
    agentOperationModel,
    agentRuntimeService,
    userId: 'user-1',
  } as any);
  return { agentOperationModel, agentRuntimeService, controller };
};

// The parked segment kept its trace partial for a resume under its own id; the
// decision continues on a fresh operation instead, so nothing reads it again.
describe('InterventionController.retirePendingApprovalOperation', () => {
  it('removes the trace partial of the segment it retires', async () => {
    const t = setUp('waiting_for_human');

    await t.controller.retirePendingApprovalOperation(OPERATION_ID);

    expect(t.agentOperationModel.recordCompletion).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'done' }),
    );
    expect(t.agentRuntimeService.removeTracePartial).toHaveBeenCalledWith(OPERATION_ID);
    expect(t.agentRuntimeService.removeTracePartial.mock.invocationCallOrder[0]).toBeGreaterThan(
      t.agentOperationModel.recordCompletion.mock.invocationCallOrder[0],
    );
  });

  it('removes it again when a retried retire finds the segment already settled', async () => {
    const t = setUp('done');

    await t.controller.retirePendingApprovalOperation(OPERATION_ID);

    expect(t.agentOperationModel.recordCompletion).not.toHaveBeenCalled();
    expect(t.agentRuntimeService.removeTracePartial).toHaveBeenCalledWith(OPERATION_ID);
  });

  it('still retires the segment when the partial cannot be removed', async () => {
    const t = setUp('waiting_for_human');
    t.agentRuntimeService.removeTracePartial.mockRejectedValue(new Error('s3 down'));

    await expect(
      t.controller.retirePendingApprovalOperation(OPERATION_ID),
    ).resolves.toBeUndefined();

    expect(t.agentOperationModel.recordCompletion).toHaveBeenCalledTimes(1);
  });

  it('keeps the partial of an operation it refuses to retire', async () => {
    const t = setUp('running');

    await expect(t.controller.retirePendingApprovalOperation(OPERATION_ID)).rejects.toThrow(
      'expected waiting_for_human',
    );

    expect(t.agentRuntimeService.removeTracePartial).not.toHaveBeenCalled();
  });
});

// A Stop on a parked approval ends the operation for good, so its retained
// partial is never resumed either.
describe('InterventionController.stopPendingApproval', () => {
  const setUpStop = () => {
    const intervention = { batchId: 'batch-1', operationId: OPERATION_ID, status: 'pending' };
    const agentRuntimeService = {
      interruptOperation: vi.fn().mockResolvedValue(true),
      loadGroupMemberBridge: vi.fn().mockResolvedValue(null),
      removeTracePartial: vi.fn().mockResolvedValue(undefined),
    };
    const agentOperationModel = {
      findById: vi
        .fn()
        .mockResolvedValue({ id: OPERATION_ID, status: 'waiting_for_human', topicId: 'tpc-1' }),
      recordCompletion: vi.fn().mockResolvedValue(true),
    };
    const messageModel = {
      findById: vi.fn().mockResolvedValue({ id: 'msg-tool', role: 'tool', topicId: 'tpc-1' }),
      findMessagePlugin: vi.fn().mockResolvedValue({ intervention }),
      listMessagePluginsByTopic: vi.fn().mockResolvedValue([{ id: 'msg-tool', intervention }]),
      resolveHumanApproval: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new InterventionController({
      agentOperationModel,
      agentRuntimeService,
      messageModel,
      userId: 'user-1',
    } as any);
    const stop = () =>
      controller.stopPendingApproval({
        batchId: 'batch-1',
        operationId: OPERATION_ID,
        toolMessageIds: ['msg-tool'],
        topicId: 'tpc-1',
      });
    return { agentOperationModel, agentRuntimeService, stop };
  };

  it('removes the trace partial of the operation it stops', async () => {
    const t = setUpStop();

    await expect(t.stop()).resolves.toMatchObject({ success: true });

    expect(t.agentOperationModel.recordCompletion).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ status: 'interrupted' }),
    );
    expect(t.agentRuntimeService.removeTracePartial).toHaveBeenCalledWith(OPERATION_ID);
  });

  it('still stops the operation when the partial cannot be removed', async () => {
    const t = setUpStop();
    t.agentRuntimeService.removeTracePartial.mockRejectedValue(new Error('s3 down'));

    await expect(t.stop()).resolves.toMatchObject({ success: true });
  });
});
