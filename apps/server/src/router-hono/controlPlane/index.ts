import { getPlatformDB } from '@lobechat/database/platform';
import debug from 'debug';
import type { Context } from 'hono';
import { Hono } from 'hono';
import type { z } from 'zod';

import { invalidateTenantAuth } from '@/auth';
import { appEnv } from '@/envs/app';
import { isRegistrableSlug } from '@/features/Tenant/reservedSlugs';
import { getTenantLiveResources } from '@/server/modules/Tenant/liveResources';
import { waitForTenantClaims } from '@/server/modules/Tenant/postgresClaims';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import { isAuthorized, parseControlPlaneToken } from '@/server/services/tenantControlPlane/auth';
import {
  ControlPlaneError,
  datasourceReadinessRequestSchema,
  datasourceRequestSchema,
  lifecycleQuerySchema,
  lifecycleRequestSchema,
  overviewQuerySchema,
  provisionQuerySchema,
  provisionRequestSchema,
} from '@/server/services/tenantControlPlane/contracts';
import { PostgresTenantDatabaseExecutor } from '@/server/services/tenantControlPlane/postgresExecutor';
import { PostgresControlPlaneRepository } from '@/server/services/tenantControlPlane/postgresRepository';
import type { ControlPlaneRepository } from '@/server/services/tenantControlPlane/repository';
import {
  type LifecycleHooks,
  TenantControlPlaneService,
  type TenantDatabaseExecutor,
} from '@/server/services/tenantControlPlane/service';

import { createLifecycleHooks } from './lifecycleHooks';

const log = debug('lobe-server:control-plane');

const MAX_BODY_BYTES = 64 * 1024;
const BASE_PATH = '/api/internal/control-plane';

export type ControlPlaneJob =
  | { eventId: string; kind: 'lifecycle'; tenantId: string }
  | { kind: 'provision'; operationId: string; tenantId: string };

export interface ControlPlaneAppDeps {
  /**
   * Starts (or resumes) the asynchronous execution of a received operation or
   * event. Called after a receipt and on every poll of unfinished work, so a
   * restarted process picks up where the previous one stopped.
   */
  schedule?: (job: ControlPlaneJob) => void;
  /** Lazily resolved so a missing backing store is a 503, not a boot failure. */
  service: () => TenantControlPlaneService | null;
  /** Console token digest; null answers every request with 503. */
  tokenDigest: ReturnType<typeof parseControlPlaneToken>;
}

const errorBody = (c: Context, status: ControlPlaneError['status'], code: string) =>
  c.json({ code }, status);

/**
 * `/api/internal/control-plane/*`: the server-to-server contract Console calls
 * to provision LobeHub tenants and drive their lifecycle (spec FR-CP-01..08).
 *
 * Root path only. The tenant is named by `tenantId` in the body or query; the
 * `x-tenant-id` header is a consistency check and never selects a tenant.
 */
export const createControlPlaneApp = (deps: ControlPlaneAppDeps) => {
  const app = new Hono().basePath(BASE_PATH);

  app.use('*', async (c, next) => {
    await next();
    // Requests carry credentials; every response gets the same header so no
    // route can forget it.
    c.header('Cache-Control', 'private, no-store');
    const requestId = c.req.header('x-request-id');
    if (requestId) c.header('x-request-id', requestId.slice(0, 128));
  });

  app.onError((error, c) => {
    if (error instanceof ControlPlaneError) return errorBody(c, error.status, error.code);
    log('unexpected control-plane error: %s', (error as Error)?.name);
    return errorBody(c, 500, 'INTERNAL');
  });

  app.notFound((c) => errorBody(c, 404, 'NOT_FOUND'));

  /** Authorises, parses and cross-checks the request; returns the input and service. */
  const prepare = async <S extends z.ZodType<{ tenantId: string }>>(
    c: Context,
    schema: S,
    source: 'body' | 'query',
  ): Promise<{ input: z.output<S>; service: TenantControlPlaneService }> => {
    if (!deps.tokenDigest) throw new ControlPlaneError(503, 'INTERNAL');
    if (!isAuthorized(deps.tokenDigest, c.req.header('authorization')))
      throw new ControlPlaneError(401, 'TOKEN_INVALID');

    let raw: unknown;
    if (source === 'query') raw = c.req.query();
    else {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_BODY_BYTES) throw new ControlPlaneError(413, 'REQUEST_TOO_LARGE');
      const text = await c.req.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
        throw new ControlPlaneError(413, 'REQUEST_TOO_LARGE');
      try {
        raw = JSON.parse(text);
      } catch {
        throw new ControlPlaneError(400, 'INVALID_INPUT');
      }
    }

    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new ControlPlaneError(400, 'INVALID_INPUT');

    const headerTenant = c.req.header('x-tenant-id');
    if (headerTenant !== undefined && headerTenant !== parsed.data.tenantId)
      throw new ControlPlaneError(403, 'TENANT_MISMATCH');

    const service = deps.service();
    if (!service) throw new ControlPlaneError(503, 'INTERNAL');
    return { input: parsed.data, service };
  };

  const statusFor = (status: string, isPost: boolean) =>
    status === 'received' || status === 'applying'
      ? 202
      : isPost && status === 'failed'
        ? 503
        : 200;

  app.post('/tenant-provision', async (c) => {
    const { input, service } = await prepare(c, provisionRequestSchema, 'body');
    const result = await service.receiveProvision(input);
    if (result.status === 'received' || result.status === 'applying')
      deps.schedule?.({
        kind: 'provision',
        operationId: input.operationId,
        tenantId: input.tenantId,
      });
    return c.json(result, statusFor(result.status, true));
  });

  app.get('/tenant-provision', async (c) => {
    const { input, service } = await prepare(c, provisionQuerySchema, 'query');
    const result = await service.getProvision(input.tenantId, input.operationId);
    if (result.status === 'received' || result.status === 'applying')
      deps.schedule?.({
        kind: 'provision',
        operationId: input.operationId,
        tenantId: input.tenantId,
      });
    return c.json(result, statusFor(result.status, false));
  });

  app.post('/tenant-readiness', async (c) => {
    const { input, service } = await prepare(c, datasourceReadinessRequestSchema, 'body');
    const result = await service.getDatasourceReadiness(input);
    return c.json(result, result.datasourceReady ? 200 : 503);
  });

  app.post('/tenant-datasource', async (c) => {
    const { input, service } = await prepare(c, datasourceRequestSchema, 'body');
    const result = await service.receiveDatasource(input);
    return c.json(result, statusFor(result.status, true));
  });

  app.post('/tenant-lifecycle', async (c) => {
    const { input, service } = await prepare(c, lifecycleRequestSchema, 'body');
    const result = await service.receiveLifecycle(input);
    if (result.status === 'received' || result.status === 'applying')
      deps.schedule?.({ eventId: input.eventId, kind: 'lifecycle', tenantId: input.tenantId });
    return c.json(result, statusFor(result.status, true));
  });

  app.get('/tenant-lifecycle', async (c) => {
    const { input, service } = await prepare(c, lifecycleQuerySchema, 'query');
    const result = await service.getLifecycle(input.tenantId, input.eventId);
    if (result.status === 'received' || result.status === 'applying')
      deps.schedule?.({ eventId: input.eventId, kind: 'lifecycle', tenantId: input.tenantId });
    return c.json(result, statusFor(result.status, false));
  });

  app.get('/tenant-overview', async (c) => {
    const { input, service } = await prepare(c, overviewQuerySchema, 'query');
    return c.json(await service.getOverview(input.tenantId));
  });

  return app;
};

/**
 * Backing store and database executor. Defaults to the Postgres repository
 * over `public.tenant_*` and the Postgres executor; tests and other hosts may
 * register their own.
 */
let backend: { database: TenantDatabaseExecutor; repository: ControlPlaneRepository } | null = null;
export const registerControlPlaneBackend = (next: typeof backend) => {
  backend = next;
  service = null;
};

const resolveBackend = () => {
  if (backend) return backend;
  if (!process.env.DATABASE_URL) return null;
  backend = {
    database: new PostgresTenantDatabaseExecutor(),
    repository: new PostgresControlPlaneRepository(getPlatformDB()),
  };
  return backend;
};

let service: TenantControlPlaneService | null = null;
const getService = () => {
  const current = resolveBackend();
  if (!current) return null;
  service ??= new TenantControlPlaneService({
    database: current.database,
    isRegistrableSlug,
    repository: current.repository,
  });
  return service;
};

let tokenDigest: ReturnType<typeof parseControlPlaneToken> = null;
try {
  tokenDigest = parseControlPlaneToken(appEnv.LOBEHUB_CONTROL_PLANE_TOKEN);
} catch (error) {
  // Refuse every call rather than crash unrelated routes sharing the process.
  log('invalid control-plane token configuration: %s', (error as Error).message);
}

/**
 * Lifecycle effects collect durable completion receipts before draining.
 */
const lifecycleHooks = (): LifecycleHooks =>
  createLifecycleHooks({
    invalidateAuth: invalidateTenantAuth,
    waitForClaims: waitForTenantClaims,
    live: getTenantLiveResources(),
    runtime: getTenantRuntime(),
  });

/** In-process runner: one execution per operation / event at a time. */
const running = new Set<string>();
const schedule = (job: ControlPlaneJob) => {
  const current = getService();
  if (!current) return;
  const key = job.kind === 'provision' ? `p:${job.operationId}` : `l:${job.eventId}`;
  if (running.has(key)) return;
  running.add(key);
  const work =
    job.kind === 'provision'
      ? current.executeProvision(job.tenantId, job.operationId).then((result) => {
          if (result.status === 'applied') getTenantRuntime().invalidate(job.tenantId);
        })
      : current.executeLifecycle(job.tenantId, job.eventId, lifecycleHooks());
  void work
    .catch((error) =>
      log('control-plane %s execution failed: %s', job.kind, (error as Error)?.name),
    )
    .finally(() => running.delete(key));
};

export default createControlPlaneApp({ tokenDigest, schedule, service: getService });
