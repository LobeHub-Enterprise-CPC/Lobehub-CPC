// @vitest-environment node
import type { LobeChatDatabase } from '@lobechat/database';
import { account, users } from '@lobechat/database/schemas';
import { getTestDB } from '@lobechat/database/test-utils';
import { verifyPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { bootstrapOwnerId, seedBootstrapOwner } from './bootstrapOwner';
import { pendingOwnerOf } from './serviceSupport';

const PASSWORD = 'Aa1!aaaaaaaaaaaaaaaaaaaa';
let db: LobeChatDatabase;

beforeEach(async () => {
  db = await getTestDB();
  await db.delete(users);
});

const TENANT = '3f1c9a52-7b4e-4c1d-9e1a-0c2b8d7f6e5a';
const owner = (email = 'owner@acme.com', password = PASSWORD) =>
  pendingOwnerOf({ email, name: 'Acme Owner', password });
const signsIn = async (email: string, password: string) => {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) return false;
  const [credential] = await db.select().from(account).where(eq(account.userId, user.id));
  return !!credential?.password && verifyPassword({ hash: credential.password, password });
};

describe('seedBootstrapOwner', () => {
  it('creates a verified email and password account that the password signs in to', async () => {
    await seedBootstrapOwner(db, await owner(), TENANT);

    const [user] = await db.select().from(users).where(eq(users.email, 'owner@acme.com'));
    expect(user).toMatchObject({ emailVerified: true, fullName: 'Acme Owner' });
    expect(user.id).toBe(bootstrapOwnerId(TENANT));
    expect(user.id).toMatch(/^user_.{27}$/);
    expect(user.preference).not.toBeNull();
    const [credential] = await db.select().from(account).where(eq(account.userId, user.id));
    expect(credential).toMatchObject({ accountId: user.id, providerId: 'credential' });
    expect(await verifyPassword({ hash: credential.password!, password: PASSWORD })).toBe(true);
  });

  it('runs again without a second account', async () => {
    await seedBootstrapOwner(db, await owner(), TENANT);
    await seedBootstrapOwner(db, await owner(), TENANT);

    expect(await db.select().from(users)).toHaveLength(1);
    expect(await db.select().from(account)).toHaveLength(1);
  });

  it('leaves an account that already has the email as it is', async () => {
    await db
      .insert(users)
      .values({ email: 'Owner@Acme.com', fullName: 'Someone', id: 'user_mine' });

    await seedBootstrapOwner(db, await owner(), TENANT);

    expect(await db.select({ id: users.id, name: users.fullName }).from(users)).toEqual([
      { id: 'user_mine', name: 'Someone' },
    ]);
    expect(await db.select().from(account)).toHaveLength(0);
  });

  it('turns the earlier initial account into a resubmitted Owner with another email', async () => {
    await seedBootstrapOwner(db, await owner(), TENANT);

    await seedBootstrapOwner(db, await owner('other@acme.com', 'Bb2@bbbbbbbbbbbbbbbbbbbb'), TENANT);

    expect(await db.select({ email: users.email, id: users.id }).from(users)).toEqual([
      { email: 'other@acme.com', id: bootstrapOwnerId(TENANT) },
    ]);
    expect(await db.select().from(account)).toHaveLength(1);
    expect(await signsIn('other@acme.com', 'Bb2@bbbbbbbbbbbbbbbbbbbb')).toBe(true);
  });

  it('gives the initial account the password a resubmission carries', async () => {
    await seedBootstrapOwner(db, await owner(), TENANT);

    await seedBootstrapOwner(db, await owner('owner@acme.com', 'Bb2@bbbbbbbbbbbbbbbbbbbb'), TENANT);

    expect(await signsIn('owner@acme.com', PASSWORD)).toBe(false);
    expect(await signsIn('owner@acme.com', 'Bb2@bbbbbbbbbbbbbbbbbbbb')).toBe(true);
  });

  it('removes the earlier initial account when the new email is another account', async () => {
    await seedBootstrapOwner(db, await owner(), TENANT);
    await db
      .insert(users)
      .values({ email: 'other@acme.com', fullName: 'Someone', id: 'user_mine' });

    await seedBootstrapOwner(db, await owner('other@acme.com'), TENANT);

    expect(await db.select({ id: users.id }).from(users)).toEqual([{ id: 'user_mine' }]);
    expect(await db.select().from(account)).toHaveLength(0);
  });
});
