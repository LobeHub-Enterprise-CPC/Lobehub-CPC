// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AsyncTaskError, AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';

import app from './index';

const mocks = vi.hoisted(() => ({
  createCaller: vi.fn(),
  embeddingChunks: vi.fn(),
  findById: vi.fn(),
  parseFileToChunks: vi.fn(),
  start: vi.fn(),
  taskModel: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/database/models/asyncTask', () => ({
  AsyncTaskModel: vi.fn(function (...args: unknown[]) {
    mocks.taskModel(...args);
    return { findById: mocks.findById, start: mocks.start, update: mocks.update };
  }),
}));
vi.mock('@/database/server', () => ({ getServerDB: async () => 'db' }));
vi.mock('@/libs/trpc/async', () => ({
  createAsyncCallerFactory: () => (ctx: unknown) => {
    mocks.createCaller(ctx);
    return {
      file: {
        embeddingChunks: mocks.embeddingChunks,
        parseFileToChunks: mocks.parseFileToChunks,
      },
    };
  },
}));
vi.mock('@/libs/trpc/utils/internalJwt', () => ({
  signInternalJWT: async (userId: string) => `jwt-for-${userId}`,
}));
vi.mock('@/server/routers/async', () => ({ asyncRouter: {} }));
vi.mock('@/server/services/chunk', () => ({ FILE_JOB_RETRIES: 2 }));

const payload = { fileId: 'f1', taskId: 't1', userId: 'u1', workspaceId: 'ws1' };

const post = (job: 'embed' | 'parse', body: unknown = payload, retried = 0) =>
  app.request(`/${job}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'Upstash-Retried': String(retried) },
    method: 'POST',
  });

describe('file job receiver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DELIVERY_SIGNING_KEY', '');
    mocks.start.mockResolvedValue(true);
    mocks.findById.mockResolvedValue({ id: 't1', status: AsyncTaskStatus.Processing });
    mocks.parseFileToChunks.mockResolvedValue({ success: true });
    mocks.embeddingChunks.mockResolvedValue({ success: true });
  });

  it('runs a queued parse task as the user and workspace it belongs to', async () => {
    const res = await post('parse');

    expect(res.status).toBe(200);
    expect(mocks.taskModel).toHaveBeenCalledWith('db', 'u1', 'ws1');
    expect(mocks.createCaller).toHaveBeenCalledWith({ authorizationToken: 'jwt-for-u1' });
    expect(mocks.parseFileToChunks).toHaveBeenCalledWith({
      fileId: 'f1',
      taskId: 't1',
      workspaceId: 'ws1',
    });
    expect(mocks.embeddingChunks).not.toHaveBeenCalled();
  });

  it('runs a queued embedding task', async () => {
    const res = await post('embed');

    expect(res.status).toBe(200);
    expect(mocks.embeddingChunks).toHaveBeenCalledWith({
      fileId: 'f1',
      taskId: 't1',
      workspaceId: 'ws1',
    });
  });

  it('takes the task before working on it', async () => {
    mocks.parseFileToChunks.mockImplementation(async () => {
      expect(mocks.start).toHaveBeenCalledWith('t1');
      return { success: true };
    });

    await post('parse');

    expect(mocks.parseFileToChunks).toHaveBeenCalledTimes(1);
  });

  it('acknowledges a redelivery of a task that already began, or is gone, without running it', async () => {
    mocks.start.mockResolvedValue(false);

    const res = await post('parse', payload, 1);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, success: true });
    expect(mocks.parseFileToChunks).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('acknowledges a failure the procedure recorded on the task itself', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.parseFileToChunks.mockRejectedValue(new Error('File content unavailable in storage.'));
    mocks.findById.mockResolvedValue({ id: 't1', status: AsyncTaskStatus.Error });

    const res = await post('parse');

    expect(res.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('puts the task back in the queue and asks for a redelivery when the work never started', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.embeddingChunks.mockRejectedValue(new Error('TENANT_UNAVAILABLE'));

    const res = await post('embed', payload, 1);

    expect(res.status).toBe(500);
    expect(mocks.update).toHaveBeenCalledWith('t1', { status: AsyncTaskStatus.Pending });
    errorSpy.mockRestore();
  });

  it('fails the task on the last delivery so it does not stay queued', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.embeddingChunks.mockRejectedValue(new Error('TENANT_UNAVAILABLE'));

    const res = await post('embed', payload, 2);

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith('t1', {
      error: new AsyncTaskError(AsyncTaskErrorType.TaskTriggerError, 'TENANT_UNAVAILABLE'),
      status: AsyncTaskStatus.Error,
    });
    errorSpy.mockRestore();
  });

  it('refuses a job without its ids, and tells the queue not to retry it', async () => {
    const res = await post('parse', { fileId: 'f1' });

    expect(res.status).toBe(400);
    expect(res.headers.get('Upstash-NonRetryable-Error')).toBe('true');
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
