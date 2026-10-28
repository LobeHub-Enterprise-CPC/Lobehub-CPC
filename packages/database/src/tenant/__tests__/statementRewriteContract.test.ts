// @vitest-environment node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { MigrationMeta } from 'drizzle-orm/migrator';
import { describe, expect, it } from 'vitest';

import { materializeTenantMigrations, materializeTenantStatement } from '../migrator';

type Expected = { kind: 'dropped' } | { kind: 'rejected' } | { kind: 'sql'; sql: string };

interface ContractCase {
  expected: Expected;
  marketDefault?: boolean;
  marketOnlyDivergence?: boolean;
  name: string;
  sourceSchema?: string;
  statement: string;
  targetSchema: string;
}

// Console-owned contract; this repository keeps a byte-identical copy at the repo root.
const contractPath = path.resolve(
  __dirname,
  '../../../../../contracts/tenant-migrations/statement-rewrite.json',
);
const { cases } = JSON.parse(readFileSync(contractPath, 'utf8')) as { cases: ContractCase[] };

const oneStatementMigration = (statement: string): MigrationMeta => ({
  bps: true,
  folderMillis: 0,
  hash: 'contract',
  sql: [statement],
});

const run = (testCase: ContractCase): Expected => {
  const { marketDefault, sourceSchema, statement, targetSchema } = testCase;
  // Market's default instance runs the chain in `public`, which the tenant runner refuses as a
  // target: only the rewrite itself applies there, without the safety preflight.
  if (marketDefault) {
    const sql = materializeTenantStatement(statement, targetSchema, sourceSchema);
    return sql === null ? { kind: 'dropped' } : { kind: 'sql', sql };
  }
  try {
    const [migration] = materializeTenantMigrations(
      [oneStatementMigration(statement)],
      targetSchema,
      sourceSchema,
    );
    return migration.sql.length === 0
      ? { kind: 'dropped' }
      : { kind: 'sql', sql: migration.sql.join('\n') };
  } catch {
    return { kind: 'rejected' };
  }
};

describe('tenant statement rewrite contract', () => {
  it('has cases to replay', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  // The Market-only divergence is a rule of Market, not of the contract.
  it.each(cases.filter((testCase) => !testCase.marketOnlyDivergence))('$name', (testCase) => {
    expect(run(testCase)).toEqual(testCase.expected);
  });
});
