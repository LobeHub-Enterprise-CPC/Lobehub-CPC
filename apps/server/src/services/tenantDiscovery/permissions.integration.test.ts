import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import type { PlatformDatabase } from '@lobechat/database/platform';
import { tenantDbNames } from '@lobechat/database/tenant';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PostgresTenantDatabaseExecutor } from '../tenantControlPlane/postgresExecutor';
import type { ProvisionStepContext } from '../tenantControlPlane/service';
import type { DiscoveryCandidate } from './candidates';
import { loadDiscoveryCandidates } from './candidates';
import { withDiscoveryPlatformClient, withLookupClient } from './connection';
import {
  ACCOUNT_LOOKUP_ROLE,
  requireLookupRole,
  verifyLookupIdentity,
  verifyLookupPermissions,
} from './permissions';
import { discoveryResults, queryTenantMembership, verifyCandidateObjects } from './query';

vi.mock('@/config/db', () => ({
  serverDBEnv: {
    get DATABASE_URL() {
      return process.env.TEST_DISCOVERY_PLATFORM_URL;
    },
  },
}));

// The distribution slot as Enterprise fills it; the fixture chain creates the same table.
vi.mock('@lobechat/business-tenant', () => ({
  businessTenantAllowList: { column: 'entry', table: 'auth_allow_list' },
  registerBusinessTenantMigrators: () => undefined,
}));

// Only an explicitly supplied disposable, isolated cluster may create this shared role.
// Never point this test at a development/business cluster, even with a fresh database.
const isolatedUrl = process.env.TEST_ACCOUNT_LOOKUP_ISOLATED_CLUSTER_URL;
const enabled = !!isolatedUrl && process.env.TEST_ACCOUNT_LOOKUP_ISOLATED_CLUSTER === '1';
const database = `td_w1_${randomUUID().replaceAll('-', '')}`;
const tenantId = `test-${randomUUID()}`;
const names = tenantDbNames(tenantId);
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
let admin: Client;
let root: Client;
let lookup: Client;
let createdDatabase = false;
let createdLookupRole = false;
let createdTenantRoles = false;
const base = () => {
  const url = new URL(isolatedUrl!);
  url.pathname = `/${database}`;
  return url;
};
const login = (user: string) => {
  const url = base();
  url.username = user;
  url.password = 'temporary-test-only';
  return url.toString();
};
let context: ProvisionStepContext;
const executor = new PostgresTenantDatabaseExecutor({
  migrators: () => [
    {
      name: 'fixture',
      journalTables: [],
      verify: async () => undefined,
      run: async (client, { schemaName }) => {
        await client.query(`
    CREATE TABLE IF NOT EXISTS ${quote(schemaName)}.users (id text PRIMARY KEY, email text, banned boolean, ban_expires timestamptz, private_value text);
    CREATE TABLE IF NOT EXISTS ${quote(schemaName)}.private_records (secret text);
    CREATE TABLE IF NOT EXISTS ${quote(schemaName)}.auth_allow_list (entry text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true, note text);
  `);
      },
    },
  ],
});
const candidate = (id = tenantId): DiscoveryCandidate => ({
  id,
  endpointVersion: 1,
  name: 'Acme',
  schemaName: tenantDbNames(id).schemaName,
  host: base().hostname,
  port: Number(base().port || 5432),
  database,
  mode: 'shared_schema',
  activeUrl: 'https://app.example.com/orgs/acme',
});

beforeAll(async () => {
  if (!enabled) return;
  admin = new Client({ connectionString: isolatedUrl });
  await admin.connect();
  if (
    (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [ACCOUNT_LOOKUP_ROLE])).rowCount
  )
    throw new Error('ISOLATED_CLUSTER_REQUIRED_LOOKUP_ROLE_ALREADY_EXISTS');
  await admin.query(`CREATE DATABASE ${quote(database)}`);
  createdDatabase = true;
  root = new Client({ connectionString: base().toString() });
  await root.connect();
  await root.query(`CREATE ROLE ${quote(names.ownerUsername)} LOGIN PASSWORD 'temporary-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    CREATE ROLE ${quote(names.runtimeUsername)} LOGIN PASSWORD 'temporary-test-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    CREATE SCHEMA ${quote(names.schemaName)} AUTHORIZATION ${quote(names.ownerUsername)};
    GRANT USAGE ON SCHEMA ${quote(names.schemaName)} TO ${quote(names.runtimeUsername)};`);
  createdTenantRoles = true;
  vi.stubEnv('TEST_DISCOVERY_PLATFORM_URL', base().toString());
  vi.stubEnv('ACCOUNT_LOOKUP_DATABASE_URL', login(ACCOUNT_LOOKUP_ROLE));
  context = {
    tenantId,
    name: 'Acme',
    slug: 'acme',
    operationId: 'fixture',
    bundle: {
      tenantId,
      datasourceKind: 'lobehub',
      deploymentRef: 'default',
      connectionVersion: 1,
      credentialBundleVersion: 1,
      schemaVersion: 1,
      schemaName: names.schemaName,
      host: base().hostname,
      port: Number(base().port || 5432),
      database,
      mode: 'shared_schema',
      tls: { enabled: false, rejectUnauthorized: true },
      schemaOwner: {
        username: names.ownerUsername,
        role: names.ownerUsername,
        password: 'temporary-test-only',
      },
      runtimeCredential: { username: names.runtimeUsername, password: 'temporary-test-only' },
    },
  };
}, 30000);
afterAll(async () => {
  if (!enabled) return;
  await lookup?.end();
  await root?.end();
  if (createdDatabase) await admin.query(`DROP DATABASE ${quote(database)} WITH (FORCE)`);
  if (createdTenantRoles)
    await admin.query(
      `DROP ROLE ${quote(names.ownerUsername)}; DROP ROLE ${quote(names.runtimeUsername)}`,
    );
  if (createdLookupRole) await admin.query(`DROP ROLE ${quote(ACCOUNT_LOOKUP_ROLE)}`);
  await admin?.end();
  vi.unstubAllEnvs();
}, 30000);

describe.skipIf(!enabled)(
  'account lookup real PostgreSQL permissions (disposable isolated cluster)',
  () => {
    it('fails before any migration when the lookup role is missing, then grants only the three columns idempotently', async () => {
      await expect(requireLookupRole(root)).rejects.toThrow('ACCOUNT_LOOKUP_ROLE_MISSING');
      await expect(executor.migrate(context)).rejects.toThrow('ACCOUNT_LOOKUP_ROLE_MISSING');
      expect(
        (await root.query('SELECT 1 FROM pg_tables WHERE schemaname=$1', [names.schemaName]))
          .rowCount,
      ).toBe(0);
      await root.query(`CREATE ROLE ${quote(ACCOUNT_LOOKUP_ROLE)} LOGIN PASSWORD 'temporary-test-only'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
      createdLookupRole = true;
      await executor.migrate(context);
      await verifyLookupPermissions(root, names.schemaName);
      await root.query(
        `REVOKE SELECT (entry) ON ${quote(names.schemaName)}.auth_allow_list FROM ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow('ALLOW_LIST');
      await root.query(
        `GRANT SELECT (entry) ON ${quote(names.schemaName)}.auth_allow_list TO ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      // No migrations need run to repair missing grants: the executor always reapplies owner grants.
      await root.query(
        `REVOKE SELECT (email) ON ${quote(names.schemaName)}.users FROM ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow('USERS_COLUMN');
      // Existing objects need a real history for checkOwnership; use a journal marker for this fixture.
      await root.query(
        `CREATE TABLE ${quote(names.schemaName)}.__drizzle_migrations (id integer); ALTER TABLE ${quote(names.schemaName)}.__drizzle_migrations OWNER TO ${quote(names.ownerUsername)}`,
      );
      await executor.migrate(context);
      await executor.migrate(context);
      lookup = new Client({
        connectionString: login(ACCOUNT_LOOKUP_ROLE),
        options: '-c search_path=pg_catalog,pg_temp',
      });
      await lookup.connect();
      await verifyLookupIdentity(lookup);
      await lookup.query(`SELECT email,banned,ban_expires FROM ${quote(names.schemaName)}.users`);
      await lookup.query(`SELECT entry FROM ${quote(names.schemaName)}.auth_allow_list`);
      for (const query of [
        `SELECT id FROM ${quote(names.schemaName)}.users`,
        `SELECT * FROM ${quote(names.schemaName)}.private_records`,
        `INSERT INTO ${quote(names.schemaName)}.users (email) VALUES ('x@example.com')`,
        `SELECT email FROM ${quote(names.schemaName)}.users WHERE private_value = 'secret'`,
        `SELECT count(id) FROM ${quote(names.schemaName)}.users`,
        `SELECT note FROM ${quote(names.schemaName)}.auth_allow_list`,
        `INSERT INTO ${quote(names.schemaName)}.auth_allow_list (entry) VALUES ('x@example.com')`,
      ])
        await expect(lookup.query(query)).rejects.toMatchObject({ code: '42501' });
    });

    it('preserves runtime execution of existing and future invoker functions while keeping lookup denied', async () => {
      const owner = new Client({ connectionString: login(names.ownerUsername) });
      const runtime = new Client({ connectionString: login(names.runtimeUsername) });
      await owner.connect();
      await runtime.connect();
      try {
        await owner.query(
          `CREATE FUNCTION ${quote(names.schemaName)}.existing_invoker() RETURNS int LANGUAGE sql AS 'SELECT 41'; REVOKE EXECUTE ON FUNCTION ${quote(names.schemaName)}.existing_invoker() FROM PUBLIC; REVOKE EXECUTE ON FUNCTION ${quote(names.schemaName)}.existing_invoker() FROM ${quote(names.runtimeUsername)}`,
        );
        await expect(
          runtime.query(`SELECT ${quote(names.schemaName)}.existing_invoker()`),
        ).rejects.toMatchObject({ code: '42501' });
        await executor.migrate(context);
        expect(
          (await runtime.query(`SELECT ${quote(names.schemaName)}.existing_invoker() AS n`)).rows[0]
            .n,
        ).toBe(41);
        await owner.query(
          `CREATE FUNCTION ${quote(names.schemaName)}.future_invoker() RETURNS int LANGUAGE sql AS 'SELECT 42'`,
        );
        expect(
          (await runtime.query(`SELECT ${quote(names.schemaName)}.future_invoker() AS n`)).rows[0]
            .n,
        ).toBe(42);
        await expect(
          lookup.query(`SELECT ${quote(names.schemaName)}.future_invoker()`),
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await owner.end();
        await runtime.end();
      }
    });

    it('rejects effective PUBLIC grants to other columns/tables and SECURITY DEFINER execution', async () => {
      for (const [grant, revoke] of [
        [
          `GRANT SELECT (private_value) ON ${quote(names.schemaName)}.users TO PUBLIC`,
          `REVOKE SELECT (private_value) ON ${quote(names.schemaName)}.users FROM PUBLIC`,
        ],
        [
          `GRANT SELECT ON ${quote(names.schemaName)}.private_records TO PUBLIC`,
          `REVOKE SELECT ON ${quote(names.schemaName)}.private_records FROM PUBLIC`,
        ],
        [
          `GRANT SELECT (note) ON ${quote(names.schemaName)}.auth_allow_list TO PUBLIC`,
          `REVOKE SELECT (note) ON ${quote(names.schemaName)}.auth_allow_list FROM PUBLIC`,
        ],
      ]) {
        await root.query(grant);
        await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow('RELATION');
        await root.query(revoke);
      }
      await root.query(
        `CREATE FUNCTION ${quote(names.schemaName)}.unsafe_lookup() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow(
        'SECURITY_DEFINER',
      );
      await root.query(
        `REVOKE EXECUTE ON FUNCTION ${quote(names.schemaName)}.unsafe_lookup() FROM PUBLIC`,
      );
      await root.query('CREATE SCHEMA extensions');
      await root.query('GRANT USAGE ON SCHEMA extensions TO PUBLIC');
      await root.query(
        `CREATE FUNCTION extensions.unsafe_lookup() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow(
        'SECURITY_DEFINER',
      );
      await root.query('REVOKE EXECUTE ON FUNCTION extensions.unsafe_lookup() FROM PUBLIC');
      await root.query(
        `CREATE FUNCTION public.unsafe_public_lookup() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow(
        'SECURITY_DEFINER',
      );
      await root.query('REVOKE EXECUTE ON FUNCTION public.unsafe_public_lookup() FROM PUBLIC');
      await root.query('CREATE SCHEMA extra_lookup; GRANT USAGE ON SCHEMA extra_lookup TO PUBLIC');
      await root.query(
        `CREATE FUNCTION extra_lookup.unsafe_lookup() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
      );
      await expect(verifyLookupPermissions(root, names.schemaName)).rejects.toThrow(
        'SECURITY_DEFINER',
      );
      await root.query('REVOKE EXECUTE ON FUNCTION extra_lookup.unsafe_lookup() FROM PUBLIC');
      await verifyLookupPermissions(root, names.schemaName);
    });

    it('proves global default revoke prevents PUBLIC EXECUTE for future functions', async () => {
      const owner = new Client({ connectionString: login(names.ownerUsername) });
      await owner.connect();
      try {
        await owner.query('BEGIN');
        await owner.query(`ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC`);
        await owner.query(
          `ALTER DEFAULT PRIVILEGES IN SCHEMA ${quote(names.schemaName)} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
        );
        await owner.query(
          `CREATE FUNCTION ${quote(names.schemaName)}.schema_only_definer() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
        );
        const ineffective = await owner.query(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [ACCOUNT_LOOKUP_ROLE, `${names.schemaName}.schema_only_definer()`],
        );
        expect(ineffective.rows[0].allowed).toBe(true);
        await owner.query('ROLLBACK');
        await owner.query(
          `CREATE FUNCTION ${quote(names.schemaName)}.future_definer() RETURNS text LANGUAGE sql SECURITY DEFINER AS 'SELECT current_user::text'`,
        );
        const result = await root.query(
          "SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed",
          [ACCOUNT_LOOKUP_ROLE, `${names.schemaName}.future_definer()`],
        );
        expect(result.rows[0].allowed).toBe(false);
        await verifyLookupPermissions(root, names.schemaName);
      } finally {
        await owner.end();
      }
    });

    it('rejects privileged identity, role switching, membership and unsafe role attributes', async () => {
      await expect(verifyLookupIdentity(root)).rejects.toThrow('IDENTITY_INVALID');
      await root.query(`SET ROLE ${quote(ACCOUNT_LOOKUP_ROLE)}`);
      await expect(verifyLookupIdentity(root)).rejects.toThrow('IDENTITY_INVALID');
      await root.query('RESET ROLE');
      for (const attr of [
        'SUPERUSER',
        'CREATEDB',
        'CREATEROLE',
        'REPLICATION',
        'BYPASSRLS',
        'INHERIT',
      ]) {
        await root.query(`ALTER ROLE ${quote(ACCOUNT_LOOKUP_ROLE)} ${attr}`);
        await expect(verifyLookupIdentity(lookup)).rejects.toThrow('IDENTITY_INVALID');
        await root.query(`ALTER ROLE ${quote(ACCOUNT_LOOKUP_ROLE)} NO${attr}`);
      }
      await root.query(`GRANT ${quote(names.runtimeUsername)} TO ${quote(ACCOUNT_LOOKUP_ROLE)}`);
      await expect(verifyLookupIdentity(lookup)).rejects.toThrow('IDENTITY_INVALID');
      await root.query(`REVOKE ${quote(names.runtimeUsername)} FROM ${quote(ACCOUNT_LOOKUP_ROLE)}`);
      await verifyLookupIdentity(lookup);
    });

    it('handles bans and parameterized emails, fails closed on missing privileges/table/wrong DB and RLS', async () => {
      await root.query(`INSERT INTO ${quote(names.schemaName)}.users (id,email,banned,ban_expires) VALUES
      ('a','allowed@example.com',false,NULL),('b','expired@example.com',true,now()-interval '1 hour'),
      ('c','permanent@example.com',true,NULL),('d','future@example.com',true,now()+interval '1 hour')`);
      for (const email of ['allowed@example.com', 'expired@example.com'])
        expect(await queryTenantMembership(lookup, [candidate()], email)).toHaveLength(1);
      for (const email of ['permanent@example.com', 'future@example.com', "' OR true --"])
        expect(await queryTenantMembership(lookup, [candidate()], email)).toHaveLength(0);
      await expect(
        verifyCandidateObjects(lookup, [{ ...candidate(), database: 'wrong_database' }]),
      ).rejects.toMatchObject({ status: 503 });
      // Not signed up yet: the allow-list address or domain finds the tenant; a ban still wins.
      await root.query(`INSERT INTO ${quote(names.schemaName)}.auth_allow_list (entry) VALUES
      ('invited@example.com'),(' Corp.Example '),('permanent@example.com'),('')`);
      for (const email of ['invited@example.com', 'new.hire@corp.example'])
        expect(await queryTenantMembership(lookup, [candidate()], email)).toHaveLength(1);
      for (const email of [
        'permanent@example.com',
        'stranger@example.com',
        'someone@sub.corp.example',
        'corp.example',
      ])
        expect(await queryTenantMembership(lookup, [candidate()], email)).toHaveLength(0);
      await root.query(
        `REVOKE SELECT (entry) ON ${quote(names.schemaName)}.auth_allow_list FROM ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await expect(
        queryTenantMembership(lookup, [candidate()], 'allowed@example.com'),
      ).rejects.toMatchObject({ status: 503 });
      await root.query(
        `GRANT SELECT (entry) ON ${quote(names.schemaName)}.auth_allow_list TO ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await root.query(
        `REVOKE SELECT (banned) ON ${quote(names.schemaName)}.users FROM ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await expect(
        queryTenantMembership(lookup, [candidate()], 'allowed@example.com'),
      ).rejects.toMatchObject({ status: 503 });
      await root.query(
        `GRANT SELECT (banned) ON ${quote(names.schemaName)}.users TO ${quote(ACCOUNT_LOOKUP_ROLE)}`,
      );
      await root.query(`ALTER TABLE ${quote(names.schemaName)}.users ENABLE ROW LEVEL SECURITY`);
      await expect(
        queryTenantMembership(lookup, [candidate()], 'allowed@example.com'),
      ).rejects.toMatchObject({ code: '42501' });
      await root.query(`ALTER TABLE ${quote(names.schemaName)}.users DISABLE ROW LEVEL SECURITY`);
      await root.query(`ALTER TABLE ${quote(names.schemaName)}.users RENAME TO absent_users`);
      await expect(
        queryTenantMembership(lookup, [candidate()], 'allowed@example.com'),
      ).rejects.toMatchObject({ status: 503 });
      await root.query(`ALTER TABLE ${quote(names.schemaName)}.absent_users RENAME TO users`);
    });

    it('cancels actual PostgreSQL lock waits for lookup and platform connections', async () => {
      const blocker = new Client({ connectionString: base().toString() });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`LOCK TABLE ${quote(names.schemaName)}.users IN ACCESS EXCLUSIVE MODE`);
        for (const run of [withLookupClient, withDiscoveryPlatformClient]) {
          const controller = new AbortController();
          const result = run(controller.signal, async (client) => {
            await client.query(`SELECT email FROM ${quote(names.schemaName)}.users`);
          });
          const rejected = expect(result).rejects.toBeDefined();
          await new Promise((resolve) => setTimeout(resolve, 80));
          const waiting = await root.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            [database],
          );
          expect(waiting.rows[0].n).toBe(1);
          controller.abort();
          await rejected;
          // Observe server-side termination while the blocker still owns the lock.
          for (let attempt = 0; attempt < 20; attempt++) {
            const pending = await root.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
              [database],
            );
            if (pending.rows[0].n === 0) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          const pending = await root.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            [database],
          );
          expect(pending.rows[0].n).toBe(0);
        }
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
    });

    it('filters eligibility independently, rejects incomplete projections, and limits select checks to the chosen organization', async () => {
      await root.query(`CREATE TABLE public.tenant_directory (tenant_id text PRIMARY KEY, name text, slug text, schema_name text, mode text, host text, port int, database text, status text);
      CREATE TABLE public.tenant_lifecycle (tenant_id text PRIMARY KEY,accepted_version int,applied_version int,desired_state text,expires_at timestamptz,freeze_reasons jsonb,updated_at timestamptz DEFAULT now());
      CREATE TABLE public.tenant_endpoint_state (tenant_id text PRIMARY KEY,accepted_version int,applied_version int,observed_at timestamptz DEFAULT now());
      CREATE TABLE public.tenant_endpoints (tenant_id text,id text,kind text,host text,active boolean);
      CREATE TABLE public.tenant_destruction (tenant_id text PRIMARY KEY,destroy_operation_id text NOT NULL,drain_result text,terminal_established_at timestamptz NOT NULL,completed_at timestamptz);`);
      const db = drizzle(root) as PlatformDatabase;
      // Tenant ids are lower-case UUIDs (endpoint contract); the label only names the scenario.
      const labels = [
        'eligible',
        'frozen',
        'offline',
        'expired',
        'unactivated',
        'disabled',
        'destroying',
        'destroyed',
        'broken',
      ];
      const uuids = Object.fromEntries(labels.map((label) => [label, randomUUID()]));
      const ids = labels.map((label) => uuids[label]);
      for (const label of labels) {
        const id = uuids[label];
        await root.query(
          "INSERT INTO public.tenant_directory VALUES($1,$2,$8,$3,'shared_schema',$4,$5,$6,$7)",
          [
            id,
            'Acme',
            tenantDbNames(id).schemaName,
            base().hostname,
            Number(base().port || 5432),
            database,
            label === 'disabled' ? 'disabled' : 'active',
            label,
          ],
        );
        await root.query(
          'INSERT INTO public.tenant_lifecycle (tenant_id,accepted_version,applied_version,desired_state,expires_at,freeze_reasons) VALUES($1,$2,0,$3,$4,$5)',
          [
            id,
            label === 'unactivated' ? 0 : 1,
            label === 'offline' ? 'offline' : label === 'frozen' ? 'frozen' : 'active',
            label === 'expired' ? new Date(0) : null,
            JSON.stringify(label === 'frozen' ? ['manual'] : []),
          ],
        );
        if (label !== 'broken') {
          await root.query(
            'INSERT INTO public.tenant_endpoint_state (tenant_id,accepted_version,applied_version) VALUES($1,1,1)',
            [id],
          );
          await root.query(
            "INSERT INTO public.tenant_endpoints VALUES($1,'default','default',null,true)",
            [id],
          );
        }
      }
      // Otherwise fully eligible, but the destruction terminal is established: barrier only
      // (not yet drained) and fully completed. Neither is ever a discovery candidate.
      await root.query(
        `INSERT INTO public.tenant_destruction (tenant_id,destroy_operation_id,drain_result,terminal_established_at,completed_at)
        VALUES ($1,'op-1',null,now(),null),($2,'op-2','drained',now(),now())`,
        [uuids.destroying, uuids.destroyed],
      );
      const signal = new AbortController().signal;
      await expect(loadDiscoveryCandidates(signal, undefined, db)).rejects.toMatchObject({
        status: 503,
      });
      expect((await loadDiscoveryCandidates(signal, uuids.eligible, db)).map((c) => c.id)).toEqual([
        uuids.eligible,
      ]);
      await root.query(
        `UPDATE public.tenant_endpoint_state SET accepted_version=2 WHERE tenant_id='${uuids.eligible}'`,
      );
      expect((await loadDiscoveryCandidates(signal, uuids.eligible, db))[0].endpointVersion).toBe(
        1,
      );
      for (const id of ids.slice(1, -1))
        expect(await loadDiscoveryCandidates(signal, id, db)).toEqual([]);
      await root.query(
        `UPDATE public.tenant_directory SET status='disabled' WHERE tenant_id='${uuids.broken}'`,
      );
      expect((await loadDiscoveryCandidates(signal, undefined, db)).map((c) => c.id)).toEqual([
        uuids.eligible,
      ]);
      // The real directory connection is aborted while waiting for this table lock.
      const blocker = new Client({ connectionString: base().toString() });
      await blocker.connect();
      await blocker.query('BEGIN; LOCK TABLE public.tenant_directory IN ACCESS EXCLUSIVE MODE');
      try {
        const controller = new AbortController();
        const result = loadDiscoveryCandidates(controller.signal);
        const rejected = expect(result).rejects.toBeDefined();
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.abort();
        await rejected;
        // PostgreSQL observes the closed socket at its 100ms connection-check interval.
        for (let attempt = 0; attempt < 30; attempt++) {
          const waiting = await root.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
            [database],
          );
          if (waiting.rows[0].n === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const pending = await root.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND wait_event_type='Lock'",
          [database],
        );
        expect(pending.rows[0].n).toBe(0);
      } finally {
        await blocker.query('ROLLBACK');
        await blocker.end();
      }
    });

    it('measures 500 schemas with cold/hot/4 concurrent hits and misses, and rejects 501', async () => {
      const all = Array.from({ length: 500 }, (_, i) => candidate(`scale-${i}`));
      // One batch setup belongs only to this disposable database.
      await root.query(
        all
          .map(
            (c, i) => `CREATE SCHEMA ${quote(c.schemaName)};
      CREATE TABLE ${quote(c.schemaName)}.users (email text,banned boolean,ban_expires timestamptz);
      GRANT USAGE ON SCHEMA ${quote(c.schemaName)} TO ${quote(ACCOUNT_LOOKUP_ROLE)};
      GRANT SELECT (email,banned,ban_expires) ON ${quote(c.schemaName)}.users TO ${quote(ACCOUNT_LOOKUP_ROLE)};
      CREATE TABLE ${quote(c.schemaName)}.auth_allow_list (entry text);
      GRANT SELECT (entry) ON ${quote(c.schemaName)}.auth_allow_list TO ${quote(ACCOUNT_LOOKUP_ROLE)};
      ${i === 0 || i === 499 ? `INSERT INTO ${quote(c.schemaName)}.users VALUES ('scale@example.com',false,null);` : ''}`,
          )
          .join('\n'),
      );
      const timings: Record<string, number[]> = {};
      const record = async (
        key: string,
        client: Client,
        email: string,
        started = performance.now(),
      ) => {
        await verifyLookupIdentity(client);
        const result = await queryTenantMembership(client, all, email);
        const duration = performance.now() - started;
        (timings[key] ??= []).push(duration);
        expect(result).toHaveLength(email === 'scale@example.com' ? 2 : 0);
      };
      for (const email of ['scale@example.com', 'miss@example.com']) {
        for (let sample = 0; sample < 20; sample++) {
          const started = performance.now();
          const cold = new Client({
            connectionString: login(ACCOUNT_LOOKUP_ROLE),
            options: '-c search_path=pg_catalog,pg_temp',
          });
          await cold.connect();
          try {
            await record(
              `cold_${email.startsWith('scale') ? 'hit' : 'miss'}`,
              cold,
              email,
              started,
            );
          } finally {
            await cold.end();
          }
        }
        for (let sample = 0; sample < 20; sample++)
          await record(`hot_${email.startsWith('scale') ? 'hit' : 'miss'}`, lookup, email);
        const pool = new Pool({
          connectionString: login(ACCOUNT_LOOKUP_ROLE),
          max: 2,
          options: '-c search_path=pg_catalog,pg_temp',
        });
        try {
          for (let batch = 0; batch < 5; batch++)
            await Promise.all(
              Array.from({ length: 4 }, async () => {
                const started = performance.now();
                const client = await pool.connect();
                try {
                  await verifyLookupIdentity(client);
                  const result = await queryTenantMembership(client, all, email);
                  (timings[`concurrent4_${email.startsWith('scale') ? 'hit' : 'miss'}`] ??=
                    []).push(performance.now() - started);
                  expect(result).toHaveLength(email.startsWith('scale') ? 2 : 0);
                } finally {
                  client.release();
                }
              }),
            );
        } finally {
          await pool.end();
        }
      }
      for (let sample = 0; sample < 20; sample++) {
        const started = performance.now();
        await verifyCandidateObjects(lookup, all);
        (timings.integrity ??= []).push(performance.now() - started);
      }
      const stats = Object.fromEntries(
        Object.entries(timings).map(([key, values]) => {
          const sorted = [...values].sort((a, b) => a - b);
          return [
            key,
            {
              samples: sorted.length,
              p50_ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1] * 100) / 100,
              p95_ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 100) / 100,
            },
          ];
        }),
      );
      console.info('TENANT_DISCOVERY_500_BENCHMARK', JSON.stringify(stats));
      if (process.env.TEST_ACCOUNT_LOOKUP_BENCHMARK_REPORT)
        await writeFile(
          process.env.TEST_ACCOUNT_LOOKUP_BENCHMARK_REPORT,
          JSON.stringify(stats, null, 2),
        );
      for (const value of Object.values(stats)) expect(value.p95_ms).toBeLessThanOrEqual(1500);
      await expect(
        verifyCandidateObjects(lookup, [...all, candidate('scale-501')]),
      ).rejects.toMatchObject({ status: 503 });
      await root.query(
        'TRUNCATE public.tenant_directory, public.tenant_lifecycle, public.tenant_endpoint_state, public.tenant_endpoints',
      );
      await root.query(
        `INSERT INTO public.tenant_directory SELECT 'scale-'||n,'Acme','acme','unused','shared_schema','127.0.0.1',5432,$1,'active' FROM generate_series(1,501) n`,
        [database],
      );
      await root.query(
        "INSERT INTO public.tenant_lifecycle (tenant_id,accepted_version,applied_version,desired_state,freeze_reasons) SELECT tenant_id,1,0,'active','[]'::jsonb FROM public.tenant_directory",
      );
      await expect(
        loadDiscoveryCandidates(
          new AbortController().signal,
          undefined,
          drizzle(root) as PlatformDatabase,
        ),
      ).rejects.toMatchObject({ status: 503 });
    }, 60000);

    it('distinguishes duplicate organization names only in matching results', () => {
      expect(discoveryResults([candidate()])).toEqual([{ id: tenantId, name: 'Acme' }]);
      const other = { ...candidate('other'), activeUrl: 'https://other.example.com', name: 'Acme' };
      expect(discoveryResults([candidate(), other])).toEqual(
        expect.arrayContaining([
          { id: tenantId, name: 'Acme', address: 'app.example.com/orgs/acme' },
          { id: 'other', name: 'Acme', address: 'other.example.com' },
        ]),
      );
    });
  },
);
