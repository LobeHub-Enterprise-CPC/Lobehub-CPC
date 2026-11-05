import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { PendingOwner } from './repository';

/**
 * The initial Owner's user id, derived from the tenant: a later Owner submission finds the account
 * an earlier one created, and nothing else in the tenant has this id.
 */
export const bootstrapOwnerId = (tenantId: string) =>
  `user_${createHash('sha256').update(`bootstrap-owner:${tenantId}`).digest('hex').slice(0, 27)}`;

/**
 * Makes the tenant's initial Owner an email and password account the way a sign-up would (a
 * `credential` account holding the hash). The email is verified: Console's operator vouches for
 * it, so the password signs in without a verification mail. Registration triggers run as for any
 * insert, so a new account joins the default department the seeders created just before.
 *
 * The initial account follows the latest Owner Console sends before the tenant opens: another
 * email or password replaces the earlier one in place. An account of someone else that already has
 * the email is left as it is (its password, verification and sessions are never touched), and the
 * earlier initial account is then removed rather than kept as a second Owner.
 *
 * Runs in an owner transaction with the tenant search_path (the `seed` step, `tenant-bootstrap-owner`).
 */
export const seedBootstrapOwner = async (
  // Only its query builders: the executor's schema-less client and a schema-bound test database.
  db: Pick<PgDatabase<PgQueryResultHKT>, 'delete' | 'insert' | 'select' | 'update'>,
  owner: PendingOwner,
  tenantId: string,
) => {
  // Loaded on use: the migration CLI imports this module's executor statically, and in that module
  // graph the database barrels' re-exports are not visible to static or namespace imports.
  const [{ createNanoId }, { account, users }] = await Promise.all([
    import('@lobechat/database'),
    import('@lobechat/database/schemas'),
  ]);
  const userId = bootstrapOwnerId(tenantId);
  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${owner.email}`)
    .limit(1);
  if (holder && holder.id !== userId) {
    await db.delete(users).where(eq(users.id, userId));
    return;
  }

  const identity = { email: owner.email, emailVerified: true, fullName: owner.name };
  const [kept] = await db
    .update(users)
    .set(identity)
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  if (!kept) await db.insert(users).values({ ...identity, id: userId });
  const [credential] = await db
    .update(account)
    .set({ password: owner.passwordHash, updatedAt: new Date() })
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .returning({ id: account.id });
  if (!credential)
    await db.insert(account).values({
      accountId: userId,
      id: createNanoId(12)(),
      password: owner.passwordHash,
      providerId: 'credential',
      updatedAt: new Date(),
      userId,
    });
};
