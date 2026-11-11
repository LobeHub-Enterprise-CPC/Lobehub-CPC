import type { Context } from 'hono';
import { Hono } from 'hono';

import { AsyncTaskModel } from '@/database/models/asyncTask';
import { getServerDB } from '@/database/server';
import { createAsyncCallerFactory } from '@/libs/trpc/async';
import { signInternalJWT } from '@/libs/trpc/utils/internalJwt';
import { asyncRouter } from '@/server/routers/async';
import { FILE_JOB_RETRIES } from '@/server/services/chunk';
import { AsyncTaskError, AsyncTaskErrorType, AsyncTaskStatus } from '@/types/asyncTask';

import { qstashAuth } from '../middlewares/qstashAuth';

type FileJob = 'embed' | 'parse';

interface FileJobPayload {
  fileId?: string;
  taskId?: string;
  userId?: string;
  workspaceId?: string;
}

/**
 * Queued half of a file task (`ChunkService.publishFileJob`): runs the async router's
 * parsing or embedding procedure in this process, as the user the task belongs to.
 *
 * Deliveries arrive at least once, and a delivery whose connection broke is repeated
 * while its first attempt may still be working. So the task is taken atomically
 * (`pending` → `processing`) before anything else: a redelivery of one that already
 * began is acknowledged untouched, and no file is parsed or embedded twice. A task whose
 * attempt died is left to the watchdog.
 *
 * The procedures record their own outcome on the task. An attempt that fails before they
 * get that far (the task is still `processing`) goes back to the queue for a redelivery,
 * and the last one marks the task failed so it does not stay queued.
 */
const runFileJob = (job: FileJob) => async (c: Context) => {
  const { fileId, taskId, userId, workspaceId } = ((await c.req.json().catch(() => ({}))) ??
    {}) as FileJobPayload;
  if (!fileId || !taskId || !userId) {
    c.header('Upstash-NonRetryable-Error', 'true');
    return c.json({ error: 'fileId, taskId and userId are required' }, 400);
  }

  const asyncTaskModel = new AsyncTaskModel(await getServerDB(), userId, workspaceId);
  if (!(await asyncTaskModel.start(taskId))) return c.json({ skipped: true, success: true });

  try {
    const caller = createAsyncCallerFactory(asyncRouter)({
      authorizationToken: await signInternalJWT(userId),
    });
    const input = { fileId, taskId, workspaceId };
    if (job === 'parse') await caller.file.parseFileToChunks(input);
    else await caller.file.embeddingChunks(input);

    return c.json({ success: true });
  } catch (error) {
    console.error(`[file/${job}] file ${fileId} task ${taskId}:`, error);

    const current = await asyncTaskModel.findById(taskId);
    // The procedure recorded the failure itself; a redelivery would change nothing.
    if (current?.status !== AsyncTaskStatus.Processing) return c.json({ success: false });

    const attempt = Number(c.req.header('Upstash-Retried') ?? 0);
    if (attempt < FILE_JOB_RETRIES) {
      await asyncTaskModel.update(taskId, { status: AsyncTaskStatus.Pending });
      return c.json({ error: 'file job did not start' }, 500);
    }

    await asyncTaskModel.update(taskId, {
      error: new AsyncTaskError(
        AsyncTaskErrorType.TaskTriggerError,
        error instanceof Error ? error.message : 'file job did not start',
      ),
      status: AsyncTaskStatus.Error,
    });
    return c.json({ success: false });
  }
};

const app = new Hono();

app.post('/parse', qstashAuth(), runFileJob('parse'));
app.post('/embed', qstashAuth(), runFileJob('embed'));

export default app;
