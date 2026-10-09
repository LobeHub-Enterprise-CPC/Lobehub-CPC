/**
 * Recovery helper for video generation tasks whose result never reached the database.
 *
 * Background: while the Volcengine/Seedance provider declared `completionModes:
 * ['webhook']` (see the fix in `packages/model-runtime/src/providers/volcengine/
 * index.ts`), the server submitted the task and then waited for a callback that
 * never arrived, so nothing was ever polled. The upstream render often succeeded
 * anyway. Those tasks are still `Processing`, or were flipped to `Error` with a
 * Timeout error by the async-task watchdog, while Ark holds a finished video.
 *
 * This script only reads upstream, classifies each candidate, and — when explicitly
 * asked with `--apply` — replays the *production* completion chain
 * (`processBackgroundVideoPolling`) for the ones whose upstream result is ready. It
 * never marks a task successful on its own: status, asset, file and charge are
 * written by the same code path the live poller uses, so a task only reaches
 * `Success` once its video really is stored.
 *
 * Usage (dry run is the default; nothing is written without `--apply`):
 *
 *   tsx scripts/recoverVideoGenerationTasks/index.ts
 *   tsx scripts/recoverVideoGenerationTasks/index.ts --limit 50
 *   tsx scripts/recoverVideoGenerationTasks/index.ts --async-task-id <uuid>
 *   tsx scripts/recoverVideoGenerationTasks/index.ts --apply --confirm-recovery
 *
 * Requirements: the usual server environment (DATABASE_URL, provider credentials,
 * S3/storage) — the same one the server process uses.
 *
 * Safety properties, see also README.md next to this file:
 *  - read-only unless `--apply` and `--confirm-recovery` are both present;
 *  - idempotent: an existing asset or an existing completion claim stops the task
 *    before any write, so a second run cannot store or charge twice;
 *  - a task is only re-opened (Error → Processing) immediately before its chain runs,
 *    and only when its upstream result is already available.
 */
import * as dotenv from 'dotenv';
import dotenvExpand from 'dotenv-expand';

// Load environment variables in the same priority order as the other maintenance
// scripts: .env, then .env.[env], then .env.[env].local.
const env = process.env.NODE_ENV || 'development';
dotenvExpand.expand(dotenv.config());
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}` }));
dotenvExpand.expand(dotenv.config({ override: true, path: `.env.${env}.local` }));

type Verdict =
  | 'recovered'
  | 'recoverable'
  | 'upstream-pending'
  | 'upstream-failed'
  | 'upstream-expired'
  | 'upstream-unreachable'
  | 'already-stored'
  | 'needs-manual-review';

interface CliOptions {
  apply: boolean;
  asyncTaskId?: string;
  confirmRecovery: boolean;
  limit: number;
}

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = { apply: false, confirmRecovery: false, limit: 200 };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    switch (arg) {
      case '--apply': {
        options.apply = true;
        break;
      }
      case '--confirm-recovery': {
        options.confirmRecovery = true;
        break;
      }
      case '--async-task-id': {
        options.asyncTaskId = argv[++index];
        break;
      }
      case '--limit': {
        options.limit = Number(argv[++index]) || options.limit;
        break;
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  if (options.apply && !options.confirmRecovery) {
    throw new Error(
      'Refusing to write: pass --confirm-recovery together with --apply once the dry-run ' +
        'output has been reviewed.',
    );
  }

  if (!options.apply && options.confirmRecovery) {
    throw new Error('--confirm-recovery is only meaningful together with --apply.');
  }

  return options;
};

const isExpiredMessage = (message: string) => /expire/i.test(message);

const run = async () => {
  const options = parseArgs(process.argv.slice(2));

  const [{ serverDB }, { and, eq, inArray, isNotNull }, schemas, { AsyncTaskStatus }, types] =
    await Promise.all([
      import('../../packages/database/src/server'),
      import('drizzle-orm'),
      import('../../packages/database/src/schemas'),
      import('../../packages/types/src/asyncTask'),
      import('@lobechat/business-model-runtime'),
    ]);

  const { asyncTasks, generationBatches, generations } = schemas;
  const { AsyncTaskType } = types;

  const candidates = await serverDB.query.asyncTasks.findMany({
    limit: options.limit,
    orderBy: (table: any, { asc }: any) => [asc(table.createdAt)],
    where: and(
      // A task without an upstream id can never be re-queried.
      isNotNull(asyncTasks.inferenceId),
      eq(asyncTasks.type, AsyncTaskType.VideoGeneration),
      inArray(asyncTasks.status, [AsyncTaskStatus.Processing, AsyncTaskStatus.Error]),
      ...(options.asyncTaskId ? [eq(asyncTasks.id, options.asyncTaskId)] : []),
    ),
  });

  console.log(
    `[recover-video] ${candidates.length} candidate task(s); mode=${options.apply ? 'APPLY' : 'dry-run'}`,
  );

  const summary = new Map<Verdict, number>();
  const addVerdict = (verdict: Verdict) => summary.set(verdict, (summary.get(verdict) ?? 0) + 1);

  for (const task of candidates) {
    const metadata = (task.metadata ?? {}) as Record<string, any>;
    const error = task.error as { name?: string; body?: { detail?: string } } | null;
    const errorName = error?.name ?? undefined;
    const errorDetail = error?.body?.detail ?? undefined;

    // Watchdog noise is only interesting when the task never produced a result.
    if (task.status === AsyncTaskStatus.Error && errorName && errorName !== 'Timeout') {
      console.log(
        `- asyncTask=${task.id} skip: terminal error "${errorName}" is not a timeout (${errorDetail ?? 'no detail'})`,
      );
      addVerdict('needs-manual-review');
      continue;
    }

    const generation = await serverDB.query.generations.findFirst({
      where: eq(generations.asyncTaskId, task.id),
    });

    if (!generation) {
      console.log(`- asyncTask=${task.id} skip: no generation row linked to this task`);
      addVerdict('needs-manual-review');
      continue;
    }

    const batch = generation.generationBatchId
      ? await serverDB.query.generationBatches.findFirst({
          where: eq(generationBatches.id, generation.generationBatchId),
        })
      : undefined;

    if (!batch?.provider || !batch?.model) {
      console.log(`- asyncTask=${task.id} skip: generation batch has no provider/model`);
      addVerdict('needs-manual-review');
      continue;
    }

    // The video is already attached: nothing to recover, and re-running the chain
    // could only add a duplicate asset.
    if ((generation.asset as { url?: string } | null)?.url) {
      console.log(`- asyncTask=${task.id} already-stored: asset ${(generation.asset as any).url}`);
      addVerdict('already-stored');
      continue;
    }

    // A previous completion already claimed the task (live poller, callback or an
    // earlier recovery run). Whether it charged is not knowable from here, so it is
    // left alone rather than replayed.
    if (metadata.completionClaimedAt) {
      console.log(
        `- asyncTask=${task.id} needs-manual-review: completion already claimed at ${metadata.completionClaimedAt}`,
      );
      addVerdict('needs-manual-review');
      continue;
    }

    const { initModelRuntimeFromDB } = await import('@/server/modules/ModelRuntime');
    const { resolvedModelId } = await types.resolveBusinessModelMapping(batch.provider, batch.model);

    let pollResult: any;
    try {
      const runtime = await initModelRuntimeFromDB(
        serverDB,
        task.userId,
        batch.provider,
        task.workspaceId ?? undefined,
      );

      // Read-only upstream lookup, pinned to the route the task was submitted with.
      pollResult = await runtime.handlePollVideoStatus(
        task.inferenceId!,
        resolvedModelId,
        metadata.route,
      );
    } catch (error_) {
      console.log(
        `- asyncTask=${task.id} upstream-unreachable (retry later): ` +
          `${error_ instanceof Error ? error_.message : String(error_)}`,
      );
      addVerdict('upstream-unreachable');
      continue;
    }

    const billingNote =
      `precharge=${Boolean(metadata.precharge)} spendOrigin=${Boolean(metadata.spendOrigin)} ` +
      `status=${task.status} createdAt=${task.createdAt?.toISOString?.() ?? task.createdAt}`;

    if (!pollResult || pollResult.status === 'pending') {
      console.log(`- asyncTask=${task.id} upstream-pending (${billingNote})`);
      addVerdict('upstream-pending');
      continue;
    }

    if (pollResult.status === 'failed') {
      const verdict: Verdict = isExpiredMessage(String(pollResult.error ?? ''))
        ? 'upstream-expired'
        : 'upstream-failed';
      console.log(`- asyncTask=${task.id} ${verdict}: ${pollResult.error} (${billingNote})`);
      addVerdict(verdict);
      continue;
    }

    // Upstream holds a finished video and nothing was stored locally: recoverable.
    if (!options.apply) {
      console.log(`- asyncTask=${task.id} recoverable (${billingNote})`);
      addVerdict('recoverable');
      continue;
    }

    const recovered = await applyRecovery({ generation, metadata, row: task, serverDB });

    console.log(`- asyncTask=${task.id} recovered=${recovered} (${billingNote})`);
    addVerdict(recovered ? 'recovered' : 'needs-manual-review');
  }

  console.log('\n[recover-video] summary');
  for (const [verdict, count] of summary) console.log(`  ${verdict}: ${count}`);
  if (!options.apply) {
    console.log('\nDry run only — nothing was written. Re-run with --apply --confirm-recovery.');
  }
};

/**
 * Re-open the task and replay the production completion chain.
 *
 * The status is flipped to `Processing` only here, immediately before the chain runs:
 * `AsyncTaskModel.claimVideoCompletion` refuses to claim a task in a terminal state,
 * and the chain is what writes the asset, the file, the success status and the
 * completion charge. If the chain fails it records the failure itself.
 */
const applyRecovery = async ({
  generation,
  metadata,
  row,
  serverDB,
}: {
  generation: any;
  metadata: Record<string, any>;
  row: any;
  serverDB: any;
}) => {
  const { and, eq, inArray } = await import('drizzle-orm');
  const { asyncTasks, generationBatches, generations } = await import(
    '../../packages/database/src/schemas'
  );
  const { AsyncTaskStatus } = await import('../../packages/types/src/asyncTask');
  const { processBackgroundVideoPolling } = await import(
    '@/server/services/generation/videoBackgroundPolling'
  );

  await serverDB
    .update(asyncTasks)
    .set({ error: null, status: AsyncTaskStatus.Processing, updatedAt: new Date() })
    .where(and(eq(asyncTasks.id, row.id), inArray(asyncTasks.status, [AsyncTaskStatus.Error])));

  const batch = await serverDB.query.generationBatches.findFirst({
    where: eq(generationBatches.id, generation.generationBatchId),
  });

  await processBackgroundVideoPolling(serverDB, {
    asyncTaskCreatedAt: row.createdAt,
    asyncTaskId: row.id,
    generationBatchId: generation.generationBatchId,
    generationId: generation.id,
    generationTopicId: batch?.generationTopicId,
    inferenceId: row.inferenceId,
    model: batch?.model,
    prechargeResult: metadata.precharge,
    previousGenerationId: metadata.previousGenerationId,
    provider: batch?.provider,
    route: metadata.route,
    spendOrigin: metadata.spendOrigin,
    userId: row.userId,
    workspaceId: row.workspaceId ?? undefined,
  });

  // The chain owns every write, so "recovered" is read back rather than assumed: the
  // task must be Success *and* the generation must carry an asset.
  const [updated, refreshedGeneration] = await Promise.all([
    serverDB.query.asyncTasks.findFirst({ where: eq(asyncTasks.id, row.id) }),
    serverDB.query.generations.findFirst({ where: eq(generations.id, generation.id) }),
  ]);

  const assetUrl = (refreshedGeneration?.asset as { url?: string } | null)?.url;

  return Boolean(updated?.status === AsyncTaskStatus.Success && assetUrl);
};

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('[recover-video] failed:', error);
    process.exit(1);
  });
