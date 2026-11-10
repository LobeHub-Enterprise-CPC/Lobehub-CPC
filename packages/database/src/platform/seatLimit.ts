import { count, eq, sql } from 'drizzle-orm';

import { users } from '../schemas/user';
import type { LobeChatDatabase } from '../type';
import { getPlatformDB, type PlatformDatabase } from './db';
import { tenantDirectory } from './schemas';

/** Raised instead of creating a member account when the tenant has reached its seat limit. */
export class SeatLimitError extends Error {
  readonly code = 'SEAT_LIMIT_REACHED';

  constructor() {
    super('SEAT_LIMIT_REACHED');
    this.name = 'SeatLimitError';
  }
}

/** The part of a database handle (or transaction) the seat check needs. */
type SeatDatabase = Pick<LobeChatDatabase, 'execute' | 'select'>;

/**
 * Inside the caller's open transaction `tx`, ensures the tenant has a seat left for one more
 * `users` row, and keeps it until that transaction ends. The caller inserts the row in the same
 * transaction, after this returns.
 *
 * The limit is set by the platform (`tenant_directory.seat_limit`, null for none) and read from
 * there on every call, so a change takes effect at once. With a limit, the call takes
 * `pg_advisory_xact_lock(hashtext('seat:' || tenantId))` on `tx` and counts the rows: concurrent
 * creators queue on the lock and each counts what its predecessors committed. Admin takes the same
 * lock when it creates a member. The lock is transaction-scoped, so a failure or a crash can never
 * leave it held. A caller that also takes other advisory locks takes this one last.
 *
 * Only creation is limited. Nothing here looks at existing accounts, so a limit lowered below the
 * number of members stops new members without affecting anyone who is already in.
 */
export const assertSeatAvailable = async (
  tx: SeatDatabase,
  tenantId: string,
  platform: () => PlatformDatabase = getPlatformDB,
): Promise<void> => {
  const [row] = await platform()
    .select({ seatLimit: tenantDirectory.seatLimit })
    .from(tenantDirectory)
    .where(eq(tenantDirectory.tenantId, tenantId))
    .limit(1);
  // A served tenant always has a directory row: without one the limit is unknown, so fail closed.
  if (!row) throw new Error('TENANT_NOT_FOUND');
  const { seatLimit } = row;
  if (seatLimit === null) return;

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`seat:${tenantId}`}))`);
  const [{ used }] = await tx.select({ used: count() }).from(users);
  if (used >= seatLimit) throw new SeatLimitError();
};

/**
 * Runs `create`, which inserts one `users` row, in a transaction that first passes
 * {@link assertSeatAvailable}. For callers that have no transaction of their own.
 */
export const withSeatLimit = <T>(
  db: LobeChatDatabase,
  tenantId: string,
  create: (db: LobeChatDatabase) => Promise<T>,
  platform: () => PlatformDatabase = getPlatformDB,
): Promise<T> =>
  db.transaction(async (tx) => {
    await assertSeatAvailable(tx, tenantId, platform);
    return create(tx as unknown as LobeChatDatabase);
  });
