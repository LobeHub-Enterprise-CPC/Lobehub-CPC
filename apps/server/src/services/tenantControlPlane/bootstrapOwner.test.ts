// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { account, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { seedBootstrapOwner } from './bootstrapOwner';
import { pendingOwnerOf } from './serviceSupport';

const PASSWORD = 'Aa1!aaaaaaaaaaaaaaaaaaaa';
let db: LobeChatDatabase;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(users);
});

const owner = () =>
  pendingOwnerOf({ email: 'owner@acme.com', name: 'Acme Owner', password: PASSWORD });

describe('seedBootstrapOwner', () => {
  it('creates a verified email and password account that the password signs in to', async () => {
    await seedBootstrapOwner(db, await owner());

    const [user] = await db.select().from(users).where(eq(users.email, 'owner@acme.com'));
    expect(user).toMatchObject({ emailVerified: true, fullName: 'Acme Owner' });
    expect(user.id).toMatch(/^user_.{27}$/);
    expect(user.preference).not.toBeNull();
    const [credential] = await db.select().from(account).where(eq(account.userId, user.id));
    expect(credential).toMatchObject({ accountId: user.id, providerId: 'credential' });
    expect(await verifyPassword({ hash: credential.password!, password: PASSWORD })).toBe(true);
  });

  it('runs again without a second account', async () => {
    await seedBootstrapOwner(db, await owner());
    await seedBootstrapOwner(db, await owner());

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it('leaves an account that already has the email as it is', async () => {
    await db
      .insert(users)
      .values({ email: 'Owner@Acme.com', fullName: 'Someone', id: 'user_mine' });

    await seedBootstrapOwner(db, await owner());

    expect(await db.select({ id: users.id, name: users.fullName }).from(users)).toEqual([
      { id: 'user_mine', name: 'Someone' },
    ]);
    expect(await db.select().from(account)).toHaveLength(0);
  });
});
