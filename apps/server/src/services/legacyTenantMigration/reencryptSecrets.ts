import { type CipherGCMTypes, createDecipheriv } from 'node:crypto';

import { symmetricDecrypt } from 'better-auth/crypto';

import { deriveTenantDataKey, openWithKey, sealWithKey } from '@/server/crypto/tenantKeys';
import { ssoSecretAad } from '@/server/services/tenantSso';

/**
 * Offline move of the secrets imported from a single-tenant release into one tenant schema
 * (Console `docs/legacy-tenant-migration.md`, step 6). The single-tenant release sealed them
 * process-wide; the tenant release reads only the tenant data key (spec A18), so every column
 * below is re-sealed once, before the tenant is opened:
 *
 * - key vaults, provider keys and credentials: legacy `KeyVaultsGateKeeper`, AES-GCM with the
 *   base64-decoded `KEY_VAULTS_SECRET`, `ivhex:taghex:cthex` → `v1` envelope, empty AAD;
 * - frontend SSO secrets: better-auth `symmetricEncrypt` under `${KEY_VAULTS_SECRET}:frontend-sso:v1`
 *   → `v1` envelope bound to `tenantId|providerId|revision`.
 *
 * A value that already opens under the tenant key counts as current, so the move can be resumed.
 * A value that opens under neither key is reported and its row left untouched. The caller runs
 * this in one transaction with writers stopped. Reports carry table, column and primary key only.
 */

export interface SqlClient {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
}

/** Columns sealed by the legacy `KeyVaultsGateKeeper` (and their replacements' writers). */
export const LEGACY_KEY_VAULT_COLUMNS = [
  ['user_settings', 'key_vaults'],
  ['ai_providers', 'key_vaults'],
  ['api_keys', 'key'],
  ['oidc_clients', 'client_secret'],
  ['user_connectors', 'credentials'],
  ['messenger_installations', 'credentials'],
  ['messenger_account_links', 'credentials'],
  ['agent_bot_providers', 'credentials'],
  ['system_bot_providers', 'credentials'],
  ['scm_identities', 'credentials'],
  ['agent_provider_accounts', 'credentials'],
] as const;

interface Location {
  column: string;
  row: string;
  table: string;
}

export interface LegacySecretsReport {
  alreadyCurrent: number;
  dryRun: boolean;
  empty: number;
  failures: Array<Location & { code: 'LEGACY_SECRET_DECRYPT_FAILED' }>;
  reencrypted: number;
  /** Tables of this list that do not exist in the schema (not created by its chain). */
  skippedTables: string[];
  tenantId: string;
}

export const openLegacyKeyVault = (legacySecret: string, value: string): string => {
  const key = Buffer.from(legacySecret, 'base64');
  const [iv, tag, body, ...rest] = value.split(':');
  if (![16, 24, 32].includes(key.length) || !iv || !tag || body === undefined || rest.length)
    throw new Error('LEGACY_PAYLOAD_INVALID');
  const algorithm = `aes-${key.length * 8}-gcm` as CipherGCMTypes;
  const decipher = createDecipheriv(algorithm, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString(
    'utf8',
  );
};

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

const primaryKey = async (db: SqlClient, table: string) => {
  const { rows } = await db.query<{ name: string }>(
    `SELECT a.attname AS name FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY a.attnum`,
    [quote(table)],
  );
  return rows.map((row) => row.name);
};

export const reencryptLegacySecrets = async (input: {
  db: SqlClient;
  dryRun?: boolean;
  /** The legacy deployment's `KEY_VAULTS_SECRET`. */
  legacySecret: string;
  tenantId: string;
}): Promise<LegacySecretsReport> => {
  const { db, legacySecret, tenantId } = input;
  if (!legacySecret) throw new Error('LEGACY_KEY_VAULTS_SECRET_REQUIRED');
  const tenantKey = deriveTenantDataKey(tenantId);
  const report: LegacySecretsReport = {
    alreadyCurrent: 0,
    dryRun: input.dryRun ?? true,
    empty: 0,
    failures: [],
    reencrypted: 0,
    skippedTables: [],
    tenantId,
  };

  const move = async (
    table: string,
    column: string,
    reseal: (value: string, row: Record<string, unknown>) => Promise<string | 'current'>,
    extraColumns: string[] = [],
  ) => {
    const { rows: exists } = await db.query<{ found: string | null }>(
      'SELECT to_regclass($1)::text AS found',
      [quote(table)],
    );
    if (!exists[0]?.found) {
      report.skippedTables.push(table);
      return;
    }
    const keys = await primaryKey(db, table);
    const selected = [...new Set([...keys, ...extraColumns])].map(quote).join(', ');
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT ctid::text AS __ctid, ${selected}, ${quote(column)} AS __value
         FROM ${quote(table)} ORDER BY ${keys.map(quote).join(', ') || 'ctid'} FOR UPDATE`,
    );
    for (const row of rows) {
      const value = row.__value as string | null;
      const location = { column, row: keys.map((k) => String(row[k])).join('|'), table };
      if (!value) {
        report.empty++;
        continue;
      }
      let next: string | 'current';
      try {
        next = await reseal(value, row);
      } catch {
        report.failures.push({ ...location, code: 'LEGACY_SECRET_DECRYPT_FAILED' });
        continue;
      }
      if (next === 'current') {
        report.alreadyCurrent++;
        continue;
      }
      report.reencrypted++;
      if (!report.dryRun)
        await db.query(`UPDATE ${quote(table)} SET ${quote(column)} = $1 WHERE ctid = $2::tid`, [
          next,
          row.__ctid,
        ]);
    }
  };

  const opens = (value: string, aad = '') => {
    try {
      openWithKey(tenantKey, value, aad);
      return true;
    } catch {
      return false;
    }
  };

  for (const [table, column] of LEGACY_KEY_VAULT_COLUMNS)
    await move(table, column, async (value) =>
      opens(value) ? 'current' : sealWithKey(tenantKey, openLegacyKeyVault(legacySecret, value)),
    );

  await move(
    'sso_providers',
    'secret_config_encrypted',
    async (value, row) => {
      const aad = ssoSecretAad(tenantId, row.provider_id as string, row.revision as number);
      if (opens(value, aad)) return 'current';
      const plaintext = await symmetricDecrypt({
        data: value,
        key: `${legacySecret}:frontend-sso:v1`,
      });
      const parsed: unknown = JSON.parse(plaintext);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('SSO_SECRET_PAYLOAD_INVALID');
      return sealWithKey(tenantKey, plaintext, aad);
    },
    ['provider_id', 'revision'],
  );
  return report;
};
