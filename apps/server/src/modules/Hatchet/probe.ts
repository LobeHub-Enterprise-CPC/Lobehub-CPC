import { APIContracts } from '@hatchet-dev/typescript-sdk/clients/rest';
import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import debug from 'debug';

import { getHatchetClient } from './client';
import { AGENT_STEP_TASK } from './config';
import { type DeliveryPurpose, STEP_METADATA_KEYS } from './purpose';

const log = debug('lobe-server:hatchet:delivery-probe');

export type DeliveryProbeResult = 'active' | 'none' | 'unknown';

/** What the probe judges deliveries against. */
export interface DeliveryCheckpoint {
  /** When the operation's durable row was created: none of its deliveries is older. */
  createdAt?: Date;
  /** `stepIndex` of the parked inline envelope, if there is one. */
  envelopeStepIndex?: number;
  /** Completed steps, which is also the index of the next step to run. */
  stepCount: number;
}

/** Whether Hatchet still holds a delivery that will run the operation's next step. */
export type DeliveryProbe = (
  operationId: string,
  checkpoint: DeliveryCheckpoint,
) => Promise<DeliveryProbeResult>;

/**
 * Run lists filter on creation, and a retried run keeps its creation time however
 * often it is re-queued, so no fixed window bounds how old an in-flight run can
 * be. The operation's own creation does, given this much clock difference
 * between the database and the engine.
 */
const CLOCK_SKEW_MS = 60_000;

/** The SDK's REST calls have no timeout of their own; a hung API must not hang the sweep. */
const PROBE_TIMEOUT_MS = 10_000;
/** Far beyond what one operation keeps in flight, so one page normally holds all of it. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/** RetryAfter backoff, waiting for a worker and waiting for a concurrency slot are all QUEUED. */
const IN_FLIGHT_RUN = [APIContracts.V1TaskStatus.QUEUED, APIContracts.V1TaskStatus.RUNNING];
/** A one-time schedule is deleted when it fires, so every listed one is still due. */
const UNFIRED_SCHEDULE = [APIContracts.ScheduledRunStatus.SCHEDULED];

const isSuccessor = (
  metadata: unknown,
  operationId: string,
  { envelopeStepIndex, stepCount }: DeliveryCheckpoint,
): boolean => {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as Record<string, unknown>;
  // Re-checked here because a multi-key metadata filter is OR on runs.
  if (meta[STEP_METADATA_KEYS.operationId] !== operationId) return false;

  const purpose = meta[STEP_METADATA_KEYS.purpose] as DeliveryPurpose | undefined;
  if (purpose !== 'step' && purpose !== 'resume') return false;
  if (Number(meta[STEP_METADATA_KEYS.stepIndex]) >= stepCount) return true;

  // A plain step delivery resumes from a parked envelope that is further ahead.
  return purpose === 'step' && envelopeStepIndex !== undefined && envelopeStepIndex >= stepCount;
};

/**
 * Whether any listed row matches, reading every page. A match on any page is
 * proof enough; "no match" is only an answer when the whole set came back in
 * one read. Offset pages over a live set are no snapshot: a delivery that
 * finishes between two reads shifts a row nobody read past the next offset.
 * Anything short of that throws, so the probe answers unknown.
 */
const anyRow = async <T>(
  fetchPage: (offset: number) => Promise<T[] | undefined>,
  matches: (row: T) => boolean,
): Promise<boolean> => {
  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await fetchPage(page * PAGE_SIZE);
    if (!Array.isArray(rows)) throw new Error('list response without rows');
    if (rows.some(matches)) return true;
    if (rows.length < PAGE_SIZE) {
      if (page > 0) throw new Error('in-flight deliveries span pages: not a snapshot');
      return false;
    }
  }
  throw new Error(`more than ${MAX_PAGES * PAGE_SIZE} deliveries in flight`);
};

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const findSuccessor = async (
  hatchet: HatchetClient,
  operationId: string,
  checkpoint: DeliveryCheckpoint,
  since: Date,
): Promise<boolean> => {
  const matches = (row: { additionalMetadata?: unknown }) =>
    isSuccessor(row.additionalMetadata, operationId, checkpoint);

  // Schedules first: one that fires hands its run to the engine and then deletes
  // itself, so looking at runs second leaves only the run's own write lag uncovered.
  const scheduled = await anyRow(
    async (offset) =>
      (
        await hatchet.schedules.list({
          additionalMetadata: [`${STEP_METADATA_KEYS.operationId}:${operationId}`],
          limit: PAGE_SIZE,
          offset,
          statuses: UNFIRED_SCHEDULE,
          workflow: AGENT_STEP_TASK,
        })
      ).rows,
    matches,
  );
  if (scheduled) return true;

  return anyRow(
    async (offset) =>
      (
        await hatchet.runs.list({
          additionalMetadata: { [STEP_METADATA_KEYS.operationId]: operationId },
          includePayloads: false,
          limit: PAGE_SIZE,
          offset,
          since,
          statuses: IN_FLIGHT_RUN,
          workflowNames: [AGENT_STEP_TASK],
        })
      ).rows,
    matches,
  );
};

/**
 * The reaper's view of Hatchet. A step delivery may legitimately wait in Hatchet
 * (tenant concurrency, retry backoff) past the operation's durable lease; while
 * one that will run the next step is queued, running or scheduled, the operation
 * is not stranded. Only `step` and `resume` deliveries count (see `purpose.ts`).
 * Any failure, timeout included, is `unknown`, and so is a checkpoint without
 * the operation's creation time, since nothing else bounds the run lookup.
 *
 * The shared client is resolved on the first probe, never at import or creation.
 */
export const createHatchetDeliveryProbe =
  (client?: HatchetClient): DeliveryProbe =>
  async (operationId, checkpoint) => {
    const createdAt = checkpoint.createdAt?.getTime();
    if (createdAt === undefined || Number.isNaN(createdAt)) {
      log('[%s] no creation time to look back from', operationId);
      return 'unknown';
    }

    try {
      const hatchet = client ?? getHatchetClient();
      const since = new Date(createdAt - CLOCK_SKEW_MS);
      const found = await withTimeout(
        findSuccessor(hatchet, operationId, checkpoint, since),
        PROBE_TIMEOUT_MS,
      );
      return found ? 'active' : 'none';
    } catch (error) {
      log('[%s] delivery probe failed: %O', operationId, error);
      return 'unknown';
    }
  };
