import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { type TenantMigrator, verifyTenantRuntime } from '@lobechat/database/tenant';
import type { Client } from 'pg';

import { TenantClaims } from '@/server/modules/Tenant/claims';
import { TenantRuntime } from '@/server/modules/Tenant/runtime';

export const createIsolationTestRuntime = (migrators: () => TenantMigrator[]) => {
  const releases: (() => Promise<void>)[] = [];
  const testRuntime = (...args: ConstructorParameters<typeof TenantRuntime>) =>
    new TenantRuntime(args[0], args[1], args[2], new TenantClaims(), (client, ctx) =>
      verifyTenantRuntime(client, ctx, migrators()),
    );
  const admitScope = async (runtime: TenantRuntime, slug: string) => {
    const work = await runtime.enterSlug(slug);
    releases.push(work.release);
    return work.scope;
  };

  return { releases, testRuntime, admitScope };
};

export const DB_NAME = `lh_tenant_it_${process.pid}_${Date.now() % 100_000}`;
export const TENANTS = [
  { id: `it-tenant-a-${process.pid}`, slug: 'acme' },
  { id: `it-tenant-b-${process.pid}`, slug: 'beta' },
];

/** A two-file chain written for `public`, like the real one. */
export const fixtureChain = () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tenant-chain-'));
  mkdirSync(path.join(folder, 'meta'));
  writeFileSync(
    path.join(folder, '0000_base.sql'),
    [
      `CREATE TABLE "public"."users" ("id" text PRIMARY KEY NOT NULL, "email" text, "banned" boolean, "ban_expires" timestamptz);`,
    ].join('--> statement-breakpoint\n'),
  );
  writeFileSync(
    path.join(folder, '0001_notes.sql'),
    `CREATE TABLE "public"."notes" ("id" text PRIMARY KEY NOT NULL, "user_id" text NOT NULL REFERENCES "public"."users"("id"));`,
  );
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({
      dialect: 'postgresql',
      entries: [
        { breakpoints: true, idx: 0, tag: '0000_base', version: '7', when: 1_700_000_000_000 },
        { breakpoints: true, idx: 1, tag: '0001_notes', version: '7', when: 1_700_000_000_001 },
      ],
      version: '7',
    }),
  );
  return folder;
};

export const dbUrl = (base: string, database: string, user?: string, password?: string) => {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
    url.password = password ?? '';
  }
  return url.toString();
};

export const prepareIsolationSchemas = async (admin: Client) => {
  await admin.query(`REVOKE CONNECT ON DATABASE "${DB_NAME}" FROM PUBLIC`);
  await admin.query(`REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS extensions`);
  await admin.query(`CREATE SCHEMA IF NOT EXISTS paradedb`);
  // The unsafe-template regression uses an explicit fixture, including on template0.
  await admin.query(`CREATE SCHEMA IF NOT EXISTS pgivm`);
  // Like Console's baseline, leave tenant roles nothing outside their schema
  // and the extension schemas, whatever else the image's template installs.
  const { rows: otherSchemas } = await admin.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
        WHERE nspname NOT LIKE 'pg\\_%'
          AND nspname NOT IN ('information_schema', 'public', 'extensions', 'paradedb', 'pdb')`,
  );
  for (const { nspname } of otherSchemas)
    await admin.query(`REVOKE ALL ON SCHEMA "${nspname}" FROM PUBLIC`);
  await admin.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`);
};
