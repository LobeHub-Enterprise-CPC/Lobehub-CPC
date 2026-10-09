import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DatasourceBundle } from './contracts';
import { datasourceBundleSchema } from './contracts';
import { redactDatasourceBundle, tenantDbNames, validateDatasourceBundle } from './datasource';

const TENANT = '7a0c3d2e-1111-4222-8333-944455556666';

const makeBundle = (tenantId: string, over: Partial<DatasourceBundle> = {}): DatasourceBundle => {
  const names = tenantDbNames(tenantId);
  return {
    connectionVersion: 1,
    credentialBundleVersion: 1,
    database: 'lobehub',
    datasourceKind: 'lobehub',
    deploymentRef: 'default',
    host: 'pg-1.db.internal',
    mode: 'shared_schema',
    port: 5432,
    runtimeCredential: { password: 'run-secret', username: names.runtimeUsername },
    schemaName: names.schemaName,
    schemaOwner: {
      password: 'owner-secret',
      role: names.ownerUsername,
      username: names.ownerUsername,
    },
    schemaVersion: 1,
    tenantId,
    tls: { enabled: true, rejectUnauthorized: true },
    ...over,
  };
};

describe('tenantDbNames', () => {
  it('derives every name from the first 24 hex chars of sha256(tenantId)', () => {
    const h24 = createHash('sha256').update(TENANT).digest('hex').slice(0, 24);
    expect(tenantDbNames(TENANT)).toEqual({
      h24,
      ownerUsername: `lh_${h24}_owner`,
      runtimeUsername: `lh_${h24}_run`,
      schemaName: `tenant_${h24}`,
    });
  });
});

describe('validateDatasourceBundle', () => {
  it('accepts a bundle Console derived for this tenant', () => {
    expect(validateDatasourceBundle(TENANT, makeBundle(TENANT))).toBeNull();
  });

  it('trusts whatever host Console sends', () => {
    expect(
      validateDatasourceBundle(TENANT, makeBundle(TENANT, { host: '10.20.30.40' })),
    ).toBeNull();
  });

  it.each<[string, Partial<DatasourceBundle>]>([
    ['another tenant', { tenantId: 'other' }],
    ['an Admin bundle', { datasourceKind: 'admin' }],
    ['a slug-derived schema', { schemaName: 'tenant_acme' }],
    ['an unsupported schema version', { schemaVersion: 2 }],
    [
      'an owner role differing from its username',
      { schemaOwner: { password: 'x', role: 'lh_other_owner', username: 'lh_x_owner' } },
    ],
    ['a foreign runtime user', { runtimeCredential: { password: 'x', username: 'lh_x_run' } }],
  ])('refuses %s with DATASOURCE_INVALID', (_, over) => {
    expect(validateDatasourceBundle(TENANT, makeBundle(TENANT, over))).toBe('DATASOURCE_INVALID');
  });
});

describe('datasourceBundleSchema', () => {
  it('mirrors Console: the runtime user may not be the owner', () => {
    const names = tenantDbNames(TENANT);
    const bundle = makeBundle(TENANT, {
      runtimeCredential: { password: 'x', username: names.ownerUsername },
    });
    expect(datasourceBundleSchema.safeParse(bundle).success).toBe(false);
    expect(datasourceBundleSchema.safeParse(makeBundle(TENANT)).success).toBe(true);
  });
});

describe('redactDatasourceBundle', () => {
  it('drops both passwords and keeps everything else', () => {
    const redacted = redactDatasourceBundle(makeBundle(TENANT));
    expect(JSON.stringify(redacted)).not.toContain('secret');
    expect(redacted.schemaOwner).toEqual({
      role: tenantDbNames(TENANT).ownerUsername,
      username: tenantDbNames(TENANT).ownerUsername,
    });
  });
});
