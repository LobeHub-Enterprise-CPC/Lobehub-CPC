// @vitest-environment node
import { createCipheriv, randomBytes } from 'node:crypto';

import { getTestDB } from '@lobechat/database/test-utils';
import { symmetricEncrypt } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { openTenantData, sealTenantData } from '@/server/crypto/tenantKeys';
import { KeyVaultsGateKeeper } from '@/server/modules/KeyVaultsEncrypt';
import { openTenantSsoSecrets } from '@/server/services/tenantSso';

import { reencryptLegacySecrets, type SqlClient } from './reencryptSecrets';

const LEGACY_SECRET = randomBytes(32).toString('base64');
const tenantId = 'legacy-alpha';

// The single-tenant KeyVaultsGateKeeper format, written independently of the code under test.
const sealLegacy = (plaintext: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(LEGACY_SECRET, 'base64'), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${body.toString('hex')}`;
};

// The tables as the tenant release's chains create them (`public` stands in for the tenant schema).
const serverDB = await getTestDB();
const client = (serverDB as unknown as { $client: SqlClient }).$client;

describe('legacy secret re-encryption', () => {
  const db: SqlClient = { query: (sql, params) => client.query(sql, params) };
  const read = async (sql: string) => (await db.query<Record<string, string>>(sql)).rows;

  beforeAll(async () => {
    vi.stubEnv('KEY_VAULTS_SECRET', 'tenant-release-master-secret');
    await db.query(`INSERT INTO users (id) VALUES ('alice'), ('bob'), ('eve')`);
    await db.query(
      `INSERT INTO user_settings (id, key_vaults) VALUES ('alice', $1), ('bob', NULL), ('eve', $2)`,
      [sealLegacy('{"openai":{"apiKey":"sk-alice"}}'), `${sealLegacy('x').slice(0, -2)}00`],
    );
    await db.query(
      `INSERT INTO ai_providers (id, user_id, key_vaults) VALUES ('openai', 'alice', $1), ('openai', 'bob', $2)`,
      [sealLegacy('{"apiKey":"sk-provider"}'), sealTenantData(tenantId, '{"apiKey":"already"}')],
    );
    await db.query(
      `INSERT INTO sso_providers (id, provider_id, display_name, issuer, protocol, revision, secret_config_encrypted)
       VALUES ('s1', 'corp', 'Corp', 'https://idp.example.com', 'oidc', 3, $1)`,
      [
        await symmetricEncrypt({
          data: JSON.stringify({ clientSecret: 'front-secret' }),
          key: `${LEGACY_SECRET}:frontend-sso:v1`,
        }),
      ],
    );
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('previews without writing', async () => {
    const before = await read('SELECT * FROM user_settings ORDER BY id');
    const report = await reencryptLegacySecrets({ db, legacySecret: LEGACY_SECRET, tenantId });
    expect(report).toMatchObject({ alreadyCurrent: 1, dryRun: true, empty: 1, reencrypted: 3 });
    expect(report.failures).toEqual([
      {
        code: 'LEGACY_SECRET_DECRYPT_FAILED',
        column: 'key_vaults',
        row: 'eve',
        table: 'user_settings',
      },
    ]);
    expect(await read('SELECT * FROM user_settings ORDER BY id')).toEqual(before);
  });

  it('re-seals so the tenant release reads the values, and is resumable', async () => {
    const report = await reencryptLegacySecrets({
      db,
      dryRun: false,
      legacySecret: LEGACY_SECRET,
      tenantId,
    });
    expect(report).toMatchObject({ alreadyCurrent: 1, reencrypted: 3 });
    expect(JSON.stringify(report)).not.toMatch(/sk-|front-secret/);

    const [alice] = await read(`SELECT key_vaults FROM user_settings WHERE id = 'alice'`);
    const gate = KeyVaultsGateKeeper.forTenant(tenantId);
    expect(await gate.decrypt(alice.key_vaults)).toEqual({
      plaintext: '{"openai":{"apiKey":"sk-alice"}}',
      wasAuthentic: true,
    });
    const [provider] = await read(
      `SELECT key_vaults FROM ai_providers WHERE id = 'openai' AND user_id = 'alice'`,
    );
    expect(openTenantData(tenantId, provider.key_vaults)).toBe('{"apiKey":"sk-provider"}');
    const [sso] = await read('SELECT * FROM sso_providers');
    expect(
      openTenantSsoSecrets(tenantId, {
        providerId: sso.provider_id,
        revision: Number(sso.revision),
        secretConfigEncrypted: sso.secret_config_encrypted,
      }),
    ).toMatchObject({ clientSecret: 'front-secret' });

    expect(
      await reencryptLegacySecrets({ db, dryRun: false, legacySecret: LEGACY_SECRET, tenantId }),
    ).toMatchObject({ alreadyCurrent: 4, reencrypted: 0 });
  });
});
