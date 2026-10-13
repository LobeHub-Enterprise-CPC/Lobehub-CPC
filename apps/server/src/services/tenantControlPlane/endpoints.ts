import { createHash } from 'node:crypto';

import {
  type PlatformDatabase,
  tenantDirectory,
  tenantEndpointEvents,
  tenantEndpoints,
  tenantEndpointState,
} from '@lobechat/database/platform';
import { and, eq, or, sql } from 'drizzle-orm';

import { appEnv } from '@/envs/app';
import { invalidateEndpointRouting } from '@/server/modules/Tenant/endpointCache';

import {
  canonicalEndpointUrl,
  type EndpointRequest,
  endpointRequestSchema,
  TenantEndpointError,
} from './endpointsContract';

export class TenantEndpointsService {
  constructor(
    private readonly db: PlatformDatabase,
    private readonly appUrl: string = appEnv.APP_URL,
  ) {}

  async get(tenantId: string) {
    return this.db.transaction((tx) => this.read(tx, tenantId), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
  }

  private async read(db: Pick<PlatformDatabase, 'select'>, tenantId: string) {
    const [row] = await db
      .select({
        slug: tenantDirectory.slug,
        updatedAt: tenantDirectory.updatedAt,
        state: tenantEndpointState,
      })
      .from(tenantDirectory)
      .leftJoin(tenantEndpointState, eq(tenantEndpointState.tenantId, tenantDirectory.tenantId))
      .where(eq(tenantDirectory.tenantId, tenantId));
    if (!row) throw new TenantEndpointError('TENANT_NOT_FOUND', 404);
    const endpoints = await db
      .select({
        id: tenantEndpoints.id,
        kind: tenantEndpoints.kind,
        host: tenantEndpoints.host,
        active: tenantEndpoints.active,
      })
      .from(tenantEndpoints)
      .where(eq(tenantEndpoints.tenantId, tenantId))
      .orderBy(tenantEndpoints.id);
    if (!row.state) {
      // Rolling upgrades may not have received Console's first snapshot yet. Absence is
      // default-only; orphan rows and database failures must never be mistaken for absence.
      if (endpoints.length) throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
      const [event] = await db
        .select({ eventId: tenantEndpointEvents.eventId })
        .from(tenantEndpointEvents)
        .where(eq(tenantEndpointEvents.tenantId, tenantId))
        .limit(1);
      if (event) throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
      const endpoint = {
        id: 'default' as const,
        kind: 'default' as const,
        host: null,
        active: true,
      };
      return {
        tenantId,
        acceptedVersion: 0,
        appliedVersion: 0,
        endpoints: [endpoint],
        activeUrl: canonicalEndpointUrl(this.appUrl, row.slug, endpoint),
        observedAt: row.updatedAt.toISOString(),
      };
    }
    if (
      !Number.isInteger(row.state.acceptedVersion) ||
      row.state.acceptedVersion < row.state.appliedVersion ||
      row.state.acceptedVersion > 2147483647 ||
      !Number.isFinite(row.state.observedAt?.getTime())
    )
      throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
    const parsed = endpointRequestSchema.safeParse({
      tenantId,
      eventId: 'read',
      version: row.state.appliedVersion,
      endpoints,
    });
    if (!parsed.success) throw new TenantEndpointError('ENDPOINTS_NOT_READY', 503);
    const active = parsed.data.endpoints.find((e) => e.active)!;
    return {
      tenantId,
      acceptedVersion: row.state.acceptedVersion,
      appliedVersion: row.state.appliedVersion,
      endpoints: parsed.data.endpoints,
      activeUrl: canonicalEndpointUrl(this.appUrl, row.slug, active),
      observedAt: row.state.observedAt.toISOString(),
    };
  }

  async receive(raw: EndpointRequest) {
    const parsed = endpointRequestSchema.safeParse(raw);
    if (!parsed.success) throw new TenantEndpointError('ENDPOINTS_INVALID', 400);
    const input = parsed.data;
    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          endpoints: [...input.endpoints].sort((a, b) => a.id.localeCompare(b.id)),
        }),
      )
      .digest('hex');
    try {
      const result = await this.db.transaction(async (tx) => {
        // Serialize revisions of this tenant; global host uniqueness is enforced by PostgreSQL.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tenant-endpoints:${input.tenantId}`}, 0))`,
        );
        const [directory] = await tx
          .select({ slug: tenantDirectory.slug })
          .from(tenantDirectory)
          .where(eq(tenantDirectory.tenantId, input.tenantId));
        if (!directory) throw new TenantEndpointError('TENANT_NOT_FOUND', 404);
        canonicalEndpointUrl(
          this.appUrl,
          directory.slug,
          input.endpoints.find((e) => e.active)!,
        );
        const reservedHosts = [
          new URL(this.appUrl).hostname,
          new URL(appEnv.INTERNAL_APP_URL || this.appUrl).hostname,
        ];
        if (input.endpoints.some((e) => e.host && reservedHosts.includes(e.host)))
          throw new TenantEndpointError('ENDPOINT_HOST_CONFLICT', 409);
        const events = await tx
          .select()
          .from(tenantEndpointEvents)
          .where(
            or(
              eq(tenantEndpointEvents.eventId, input.eventId),
              and(
                eq(tenantEndpointEvents.tenantId, input.tenantId),
                eq(tenantEndpointEvents.version, input.version),
              ),
            ),
          );
        if (
          events.some(
            (e) =>
              e.eventId !== input.eventId ||
              e.tenantId !== input.tenantId ||
              e.version !== input.version ||
              e.payloadHash !== payloadHash,
          )
        )
          throw new TenantEndpointError('ENDPOINT_VERSION_CONFLICT', 409);
        const [state] = await tx
          .select()
          .from(tenantEndpointState)
          .where(eq(tenantEndpointState.tenantId, input.tenantId));
        const superseded = !!state && state.appliedVersion > input.version;
        if (!events.length)
          await tx.insert(tenantEndpointEvents).values({
            eventId: input.eventId,
            tenantId: input.tenantId,
            version: input.version,
            payloadHash,
          });
        if (!superseded && (!state || state.appliedVersion < input.version)) {
          await tx.delete(tenantEndpoints).where(eq(tenantEndpoints.tenantId, input.tenantId));
          await tx
            .insert(tenantEndpoints)
            .values(input.endpoints.map((e) => ({ ...e, tenantId: input.tenantId })));
          await tx
            .insert(tenantEndpointState)
            .values({
              tenantId: input.tenantId,
              acceptedVersion: input.version,
              appliedVersion: input.version,
            })
            .onConflictDoUpdate({
              target: tenantEndpointState.tenantId,
              set: {
                acceptedVersion: input.version,
                appliedVersion: input.version,
                observedAt: new Date(),
              },
            });
        }
        const current = await this.read(tx, input.tenantId);
        return {
          tenantId: input.tenantId,
          eventId: input.eventId,
          version: input.version,
          acceptedVersion: current.acceptedVersion,
          appliedVersion: current.appliedVersion,
          status: superseded ? ('superseded' as const) : ('applied' as const),
          errorCode: null,
          activeUrl: current.activeUrl,
          observedAt: current.observedAt,
        };
      });
      invalidateEndpointRouting();
      return result;
    } catch (error) {
      const pg =
        (error as { cause?: { code?: string; constraint?: string } }).cause ??
        (error as { code?: string; constraint?: string });
      if (pg.code === '23505')
        throw new TenantEndpointError(
          pg.constraint === 'tenant_endpoints_host_idx'
            ? 'ENDPOINT_HOST_CONFLICT'
            : 'ENDPOINT_VERSION_CONFLICT',
          409,
        );
      throw error;
    }
  }
}
