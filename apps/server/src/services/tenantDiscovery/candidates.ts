import { isWellFormedTenantSlug } from '@lobechat/business-tenant/routing';
import type { PlatformDatabase } from '@lobechat/database/platform';
import {
  tenantDirectory,
  tenantEndpoints,
  tenantEndpointState,
  tenantLifecycle,
} from '@lobechat/database/platform';
import { tenantDbNames } from '@lobechat/database/tenant';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';

import { appEnv } from '@/envs/app';

import {
  canonicalEndpointUrl,
  endpointRequestSchema,
} from '../tenantControlPlane/endpointsContract';
import { effectiveTenantState } from '../tenantControlPlane/service';
import { withDiscoveryPlatformClient } from './connection';
import { unavailable } from './errors';

export interface DiscoveryCandidate {
  activeUrl: string;
  database: string;
  endpointVersion: number;
  host: string;
  id: string;
  mode: string;
  name: string;
  port: number;
  schemaName: string;
}
const invalid = (id: string, reason: string): never => {
  console.error('TENANT_DISCOVERY_CANDIDATE_INVALID', { tenantId: id, reason });
  throw unavailable();
};

/** Business eligibility is independent of infrastructure readiness: never drop a broken candidate. */
export const loadDiscoveryCandidates = async (
  signal: AbortSignal,
  tenantId?: string,
  db?: PlatformDatabase,
): Promise<DiscoveryCandidate[]> => {
  signal.throwIfAborted();
  if (!db)
    return withDiscoveryPlatformClient(signal, (client) =>
      loadDiscoveryCandidates(signal, tenantId, drizzle(client) as PlatformDatabase),
    );
  return db.transaction(
    async (tx) => {
      signal.throwIfAborted();
      await tx.execute(sql`SET LOCAL statement_timeout = '5000ms'`);
      await tx.execute(sql`SET LOCAL lock_timeout = '5000ms'`);
      signal.throwIfAborted();
      const rows = await tx
        .select({
          id: tenantDirectory.tenantId,
          name: tenantDirectory.name,
          slug: tenantDirectory.slug,
          schemaName: tenantDirectory.schemaName,
          mode: tenantDirectory.mode,
          host: tenantDirectory.host,
          port: tenantDirectory.port,
          database: tenantDirectory.database,
          lifecycle: tenantLifecycle,
        })
        .from(tenantDirectory)
        .leftJoin(tenantLifecycle, eq(tenantDirectory.tenantId, tenantLifecycle.tenantId))
        .where(
          and(
            eq(tenantDirectory.status, 'active'),
            tenantId ? eq(tenantDirectory.tenantId, tenantId) : undefined,
          ),
        );
      signal.throwIfAborted();
      const now = new Date();
      const eligible = rows.filter(
        ({ lifecycle }) =>
          lifecycle &&
          lifecycle.acceptedVersion > 0 &&
          effectiveTenantState(
            {
              ...lifecycle,
              expiresAt: lifecycle.expiresAt?.toISOString() ?? null,
            },
            now,
          ).state === 'active',
      );
      if (eligible.length > 500) {
        console.error('TENANT_DISCOVERY_UNAVAILABLE', { reason: 'TOO_MANY_CANDIDATES' });
        throw unavailable();
      }
      if (!eligible.length) return [];
      const ids = eligible.map((r) => r.id);
      const states = await tx
        .select()
        .from(tenantEndpointState)
        .where(inArray(tenantEndpointState.tenantId, ids));
      signal.throwIfAborted();
      const endpoints = await tx
        .select()
        .from(tenantEndpoints)
        .where(inArray(tenantEndpoints.tenantId, ids));
      signal.throwIfAborted();
      return eligible.map((row) => {
        if (!isWellFormedTenantSlug(row.slug)) invalid(row.id, 'SLUG_BINDING');
        if (row.schemaName !== tenantDbNames(row.id).schemaName) invalid(row.id, 'SCHEMA_BINDING');
        if (row.mode !== 'shared_schema') invalid(row.id, 'UNSUPPORTED_DATABASE');
        if (
          row.host !== eligible[0].host ||
          row.port !== eligible[0].port ||
          row.database !== eligible[0].database
        )
          invalid(row.id, 'DATABASE_BINDING');
        const state = states.find((s) => s.tenantId === row.id);
        const parsed = endpointRequestSchema.safeParse({
          tenantId: row.id,
          eventId: 'discovery',
          version: state?.appliedVersion,
          endpoints: endpoints
            .filter((e) => e.tenantId === row.id)
            .map(({ id, kind, host, active }) => ({ id, kind, host, active })),
        });
        if (
          !state ||
          !Number.isInteger(state.acceptedVersion) ||
          state.acceptedVersion < state.appliedVersion ||
          state.acceptedVersion > 2147483647 ||
          !Number.isFinite(state.observedAt?.getTime()) ||
          !parsed.success
        )
          return invalid(row.id, 'ENDPOINTS_NOT_READY');
        return {
          ...row,
          endpointVersion: state.appliedVersion,
          activeUrl: canonicalEndpointUrl(
            appEnv.APP_URL,
            row.slug,
            parsed.data.endpoints.find((e) => e.active)!,
          ),
        };
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
};
