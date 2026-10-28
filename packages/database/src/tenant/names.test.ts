// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertTenantSchemaName,
  isTenantId,
  isTenantSchemaName,
  tenantDbNames,
  tenantHash,
  tenantOwnerRoleForSchema,
} from './names';

// contracts/tenant-control-plane/tenant-naming.json is Console's, byte-identical here
// (`bun run contracts:check` in Console). Console's sql/tenant_control.sql `_names` is the
// authority; the same cases are asserted by every application.
const naming = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('./../../../../contracts/tenant-control-plane/tenant-naming.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  cases: {
    h24: string;
    roles: { lobehub: { owner: string; run: string } };
    schemaName: string;
    tenantId: string;
  }[];
  invalidSchemaNames: string[];
  invalidTenantIds: string[];
  schemaNamePattern: string;
  tenantIdPattern: string;
};

describe('tenant names follow the cross-repository naming contract', () => {
  it.each(naming.cases.map((c) => [c.tenantId, c] as const))(
    'derives the contract names for %s',
    (_id, expected) => {
      expect(tenantHash(expected.tenantId)).toBe(expected.h24);
      expect(tenantDbNames(expected.tenantId)).toEqual({
        h24: expected.h24,
        ownerUsername: expected.roles.lobehub.owner,
        runtimeUsername: expected.roles.lobehub.run,
        schemaName: expected.schemaName,
      });
      expect(isTenantId(expected.tenantId)).toBe(true);
      expect(isTenantSchemaName(expected.schemaName)).toBe(true);
      expect(assertTenantSchemaName(expected.schemaName)).toBe(expected.schemaName);
      expect(tenantOwnerRoleForSchema(expected.schemaName)).toBe(expected.roles.lobehub.owner);
    },
  );

  it('refuses every id and schema name the contract lists as invalid', () => {
    for (const id of naming.invalidTenantIds)
      expect(isTenantId(id), JSON.stringify(id)).toBe(false);
    for (const name of naming.invalidSchemaNames) {
      expect(isTenantSchemaName(name), JSON.stringify(name)).toBe(false);
      expect(() => assertTenantSchemaName(name)).toThrow('TENANT_SCHEMA_NAME_INVALID');
      expect(() => tenantOwnerRoleForSchema(name)).toThrow('TENANT_SCHEMA_NAME_INVALID');
    }
    expect(isTenantId(undefined)).toBe(false);
  });

  it('uses the contract patterns', () => {
    for (const { schemaName, tenantId } of naming.cases) {
      expect(new RegExp(naming.tenantIdPattern).test(tenantId)).toBe(true);
      expect(new RegExp(naming.schemaNamePattern).test(schemaName)).toBe(true);
    }
    // Probe both validators with the same strings: no hand-copied pattern may drift from the file.
    const probes = [...naming.invalidTenantIds, ...naming.cases.map((c) => c.tenantId)];
    for (const probe of probes)
      expect(isTenantId(probe)).toBe(new RegExp(naming.tenantIdPattern).test(probe));
    const schemaProbes = [...naming.invalidSchemaNames, ...naming.cases.map((c) => c.schemaName)];
    for (const probe of schemaProbes)
      expect(isTenantSchemaName(probe)).toBe(new RegExp(naming.schemaNamePattern).test(probe));
  });
});
