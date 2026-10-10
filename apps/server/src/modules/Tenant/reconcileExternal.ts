import {
  getPlatformDB,
  tenantDirectory,
  tenantRuntimeExternalWork,
} from '@lobechat/database/platform';
import {
  runWithTenantScope,
  TenantDatabaseSession,
  tenantDbNames,
} from '@lobechat/database/tenant';
import type { PollVideoStatusResult } from '@lobechat/model-runtime';
import type { VideoGenerationRoute, VideoGenerationTaskMetadata } from '@lobechat/types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Pool } from 'pg';

import type { TrustedClientUserInfo } from '@/libs/trusted-client';
import { openDirectoryData } from '@/server/crypto/tenantKeys';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { MarketService } from '@/server/services/market';
import { MarketSandboxProvider } from '@/server/services/sandbox/providers/market';
import { OnlyboxesSandboxProvider } from '@/server/services/sandbox/providers/onlyboxes';
import type { SandboxProvider, SandboxServiceOptions } from '@/server/services/sandbox/types';
import { directorySecretAad } from '@/server/services/tenantControlPlane/postgresRepository';

type Work = typeof tenantRuntimeExternalWork.$inferSelect;

/** Maintenance uses the runtime role with PostgreSQL enforcing read-only transactions. */
async function pollVideo(work: Work): Promise<PollVideoStatusResult | undefined> {
  const context = work.context;
  if (
    !context ||
    typeof context.userId !== 'string' ||
    typeof context.provider !== 'string' ||
    typeof context.model !== 'string'
  )
    throw new Error('EXTERNAL_WORK_CONTEXT_MISSING');
  const [directory] = await getPlatformDB()
    .select()
    .from(tenantDirectory)
    .where(eq(tenantDirectory.tenantId, work.tenantId))
    .limit(1);
  if (!directory) throw new Error('TENANT_NOT_FOUND');
  const names = tenantDbNames(work.tenantId);
  if (
    directory.schemaName !== names.schemaName ||
    directory.runtimeUsername !== names.runtimeUsername
  )
    throw new Error('TENANT_DIRECTORY_MISMATCH');
  const pool = new Pool({
    host: directory.host,
    port: directory.port,
    database: directory.database,
    user: directory.runtimeUsername,
    password: openDirectoryData(
      directory.runtimeSecret,
      directorySecretAad(work.tenantId, directory.credentialBundleVersion, 'runtime'),
    ),
    ssl: directory.tls.enabled
      ? {
          rejectUnauthorized: directory.tls.rejectUnauthorized,
          ...(directory.tls.ca && { ca: directory.tls.ca }),
        }
      : false,
    options: '-c default_transaction_read_only=on',
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
  });
  const session = new TenantDatabaseSession({
    acquire: () => ({ pool, release: () => {} }),
    schemaName: directory.schemaName,
    tenantId: work.tenantId,
  });
  try {
    const marker = await session.database.execute(
      sql`SELECT tenant_id FROM tenant_metadata WHERE tenant_id=${work.tenantId} AND datasource_kind='lobehub'`,
    );
    if (marker.rows.length !== 1) throw new Error('TENANT_MARKER_MISMATCH');
    return await runWithTenantScope(
      { session, tenantId: work.tenantId, slug: directory.slug },
      async () => {
        const runtime = await initModelRuntimeFromDB(
          session.database,
          context.userId as string,
          context.provider as string,
          typeof context.workspaceId === 'string' ? context.workspaceId : undefined,
        );
        return runtime.handlePollVideoStatus(
          work.handle!,
          context.model as string,
          context.route as VideoGenerationRoute | undefined,
        );
      },
    );
  } finally {
    await pool.end();
  }
}

/** Operator-only reconciliation: queries the provider; there is no force/TTL/manual-success path. */
export const reconcileExternalWork = async (workId: string) => {
  const db = getPlatformDB();
  const [work] = await db
    .select()
    .from(tenantRuntimeExternalWork)
    .where(eq(tenantRuntimeExternalWork.workId, workId))
    .limit(1);
  if (!work) throw new Error('EXTERNAL_WORK_NOT_FOUND');
  if (work.completedAt) return { workId, terminal: true, alreadyRecorded: true };
  if (!work.handle) throw new Error('EXTERNAL_WORK_HANDLE_UNKNOWN_REQUIRES_PROVIDER_LOOKUP');
  let result: unknown;
  if (work.kind === 'video') {
    const status = await pollVideo(work);
    if (!status || status.status === 'pending') return { workId, terminal: false };
    result = status;
  } else if (work.kind === 'sandbox') {
    const [tenantId, kind, userId, topicId, sandboxInstanceId, commandId] = JSON.parse(work.handle);
    if (
      tenantId !== work.tenantId ||
      typeof userId !== 'string' ||
      typeof topicId !== 'string' ||
      typeof commandId !== 'string'
    )
      throw new Error('EXTERNAL_WORK_CONTEXT_MISSING');
    let provider: SandboxProvider;
    if (kind === 'onlyboxes') {
      provider = new OnlyboxesSandboxProvider({
        userId,
        topicId,
        sandboxInstanceId,
      } as SandboxServiceOptions);
    } else if (kind === 'market') {
      const identity = work.context?.identity as TrustedClientUserInfo | undefined;
      if (
        !identity ||
        identity.userId !== userId ||
        typeof work.context?.sealedSpecification !== 'string'
      )
        throw new Error('EXTERNAL_WORK_CONTEXT_MISSING');
      provider = new MarketSandboxProvider({
        userId,
        topicId,
        sandboxInstanceId,
        marketService: new MarketService({ userInfo: identity }),
        sandboxSpecification:
          JSON.parse(
            openDirectoryData(
              work.context.sealedSpecification,
              `${work.tenantId}|${work.workId}|specification`,
            ),
          ) ?? undefined,
        sandboxMode: work.context?.sandboxMode as SandboxServiceOptions['sandboxMode'],
        sandboxCwd:
          typeof work.context?.sandboxCwd === 'string' ? work.context.sandboxCwd : undefined,
        sandboxWorkingDir:
          typeof work.context?.sandboxWorkingDir === 'string'
            ? work.context.sandboxWorkingDir
            : undefined,
      });
    } else throw new Error('EXTERNAL_PROVIDER_RECONCILIATION_UNSUPPORTED');
    const status = await provider.callTool('getCommandOutput', { commandId });
    if (status.result?.running !== false) return { workId, terminal: false };
    result = { running: false, provider: kind, commandId };
  } else throw new Error('EXTERNAL_PROVIDER_RECONCILIATION_UNSUPPORTED');
  await db
    .update(tenantRuntimeExternalWork)
    .set({ completedAt: new Date(), receipt: { source: 'operator-provider-query', result } })
    .where(
      and(
        eq(tenantRuntimeExternalWork.workId, workId),
        eq(tenantRuntimeExternalWork.tenantId, work.tenantId),
        isNull(tenantRuntimeExternalWork.completedAt),
      ),
    );
  return { workId, terminal: true };
};

/** Replays result processing only after normal tenant admission has resumed. */
export const completeExternalVideo = async (workId: string) => {
  const [work] = await getPlatformDB()
    .select()
    .from(tenantRuntimeExternalWork)
    .where(eq(tenantRuntimeExternalWork.workId, workId))
    .limit(1);
  if (!work || work.kind !== 'video' || !work.completedAt || !work.handle)
    throw new Error('VIDEO_TERMINAL_RECEIPT_REQUIRED');
  const result = work.receipt?.result as
    { status?: string; error?: unknown; videoUrl?: string } | undefined;
  if (!result || !['success', 'error', 'failed'].includes(result.status || ''))
    throw new Error('VIDEO_TERMINAL_RECEIPT_REQUIRED');
  const terminalReceipt: Exclude<PollVideoStatusResult, { status: 'pending' }> =
    result.status === 'success'
      ? (result as Extract<PollVideoStatusResult, { status: 'success' }>)
      : { status: 'failed', error: String(result.error || 'Video generation failed') };
  const { runInTenant } = await import('./gate');
  return runInTenant(work.tenantId, async () => {
    const [
      { getServerDB },
      { processBackgroundVideoPolling },
      { asyncTasks, generations, generationBatches },
    ] = await Promise.all([
      import('@/database/server'),
      import('@/server/services/generation/videoBackgroundPolling'),
      import('@/database/schemas'),
    ]);
    const db = await getServerDB();
    const taskId = workId.slice('video:'.length);
    const [task] = await db.select().from(asyncTasks).where(eq(asyncTasks.id, taskId)).limit(1);
    if (
      !task ||
      task.userId !== work.context?.userId ||
      (task.workspaceId ?? undefined) !== work.context?.workspaceId
    )
      throw new Error('VIDEO_TASK_CONTEXT_MISMATCH');
    if (['success', 'error'].includes(task.status ?? ''))
      return { workId, businessCompleted: true, alreadyRecorded: true };
    const metadata = task.metadata as VideoGenerationTaskMetadata | null;
    if (metadata?.completionClaimedAt) throw new Error('VIDEO_COMPLETION_ALREADY_CLAIMED');
    const [generation] = await db
      .select()
      .from(generations)
      .where(and(eq(generations.asyncTaskId, taskId), eq(generations.userId, task.userId)))
      .limit(1);
    if (!generation?.generationBatchId) throw new Error('VIDEO_GENERATION_NOT_FOUND');
    const [batch] = await db
      .select()
      .from(generationBatches)
      .where(
        and(
          eq(generationBatches.id, generation.generationBatchId),
          eq(generationBatches.userId, task.userId),
        ),
      )
      .limit(1);
    if (!batch) throw new Error('VIDEO_BATCH_NOT_FOUND');
    await processBackgroundVideoPolling(db, {
      asyncTaskCreatedAt: task.createdAt,
      asyncTaskId: taskId,
      generationBatchId: batch.id,
      generationId: generation.id,
      generationTopicId: batch.generationTopicId!,
      inferenceId: work.handle!,
      model: batch.model,
      provider: batch.provider,
      userId: task.userId,
      workspaceId: task.workspaceId ?? undefined,
      terminalReceipt,
      prechargeResult: metadata?.precharge,
      previousGenerationId: metadata?.previousGenerationId,
      spendOrigin: metadata?.spendOrigin,
    });
    const [completed] = await db
      .select({ status: asyncTasks.status })
      .from(asyncTasks)
      .where(eq(asyncTasks.id, taskId))
      .limit(1);
    if (!completed || !['success', 'error'].includes(completed.status ?? ''))
      throw new Error('VIDEO_BUSINESS_COMPLETION_UNCONFIRMED');
    return { workId, businessCompleted: true };
  });
};
