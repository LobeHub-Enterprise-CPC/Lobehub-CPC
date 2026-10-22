import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDestruction } from '@lobechat/database/platform';
import { eq, sql } from 'drizzle-orm';

/**
 * The application side of the per-tenant destruction contract
 * (contracts/tenant-control-plane/tenant-destruction.json).
 *
 * `tenant_destruction` is the durable terminal. Every path that can write platform state for a tenant
 * UUID reads it in the transaction that writes and refuses a destroyed or mid-destruction UUID.
 * Control-plane transactions get that check for free, because they all run under the tenant control
 * lock the barrier also holds. Writers that run outside that lock (endpoint revisions, external-work
 * receipts) take the shared side of the destruction fence instead: the barrier takes the exclusive
 * side, so a writer either finished before the barrier committed or sees the terminal.
 */

type Tx = Parameters<Parameters<PlatformDatabase['transaction']>[0]>[0];
type Reader = Pick<PlatformDatabase, 'select'>;

export type DrainResult = 'drained' | 'fenced';

export interface DestructionRecord {
  completedAt: string | null;
  destroyOperationId: string;
  drainResult: DrainResult | null;
  tenantId: string;
  terminalEstablishedAt: string;
}

export const toDestructionRecord = (
  row: typeof tenantDestruction.$inferSelect,
): DestructionRecord => ({
  completedAt: row.completedAt?.toISOString() ?? null,
  destroyOperationId: row.destroyOperationId,
  drainResult: row.drainResult,
  tenantId: row.tenantId,
  terminalEstablishedAt: row.terminalEstablishedAt.toISOString(),
});

export const readDestruction = async (
  db: Reader,
  tenantId: string,
): Promise<DestructionRecord | null> => {
  const [row] = await db
    .select()
    .from(tenantDestruction)
    .where(eq(tenantDestruction.tenantId, tenantId))
    .limit(1);
  return row ? toDestructionRecord(row) : null;
};

const fenceKey = (tenantId: string) => `lobehub:tenant-destruction:${tenantId}`;

/** Barrier and unregister: no fenced writer is in flight while this is held. */
export const lockDestructionFenceExclusive = async (tx: Tx, tenantId: string) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${fenceKey(tenantId)}, 0))`);
};

/** Writers outside the tenant control lock: concurrent with each other, never with the barrier. */
export const lockDestructionFenceShared = async (tx: Tx, tenantId: string) => {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${fenceKey(tenantId)}, 0))`,
  );
};

/**
 * Runs `write` in a transaction that first takes the shared fence and re-checks the terminal.
 * `refuse` builds the error of the caller's own protocol.
 */
export const withDestructionFence = <T>(
  db: PlatformDatabase,
  tenantId: string,
  refuse: () => Error,
  write: (tx: Tx) => Promise<T>,
): Promise<T> =>
  db.transaction(async (tx) => {
    await lockDestructionFenceShared(tx, tenantId);
    if (await readDestruction(tx, tenantId)) throw refuse();
    return write(tx);
  });
