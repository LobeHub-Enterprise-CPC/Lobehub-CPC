import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import type { PendingOwner } from './repository';

/**
 * Creates the tenant's initial Owner as an email and password account, the way a sign-up would
 * (ids from the same generators as Better Auth's, a `credential` account holding the hash). The
 * email is verified: Console's operator vouches for it, so the password signs in without a
 * verification mail. Registration triggers run as for any insert, so the account joins the
 * default department the seeders created just before.
 *
 * Runs in the `seed` step's owner transaction with the tenant search_path. An account with the
 * same email is left as it is (a resumed seed, or a person who already registered): its password,
 * verification and sessions are never touched.
 */
export const seedBootstrapOwner = async (
  // Only its query builders: the executor's schema-less client and a schema-bound test database.
  db: Pick<PgDatabase<PgQueryResultHKT>, 'insert' | 'select'>,
  owner: PendingOwner,
) => {
  // Loaded on use: the migration CLI imports this module's executor statically, and in that module
  // graph the database barrels' re-exports are not visible to static or namespace imports.
  const [{ createNanoId, idGenerator }, { account, users }] = await Promise.all([
    import('@lobechat/database'),
    import('@lobechat/database/schemas'),
  ]);
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${owner.email}`)
    .limit(1);
  if (existing) return;

  const userId = idGenerator('user', 32 - 'user_'.length);
  await db.insert(users).values({
    email: owner.email,
    emailVerified: true,
    fullName: owner.name,
    id: userId,
  });
  await db.insert(account).values({
    accountId: userId,
    id: createNanoId(12)(),
    password: owner.passwordHash,
    providerId: 'credential',
    updatedAt: new Date(),
    userId,
  });
};
