import { type Context, Hono } from 'hono';

import { appEnv } from '@/envs/app';
import { gatewayEnv } from '@/envs/gateway';
import { tenantGateErrorOf } from '@/server/modules/Tenant/errors';
import { runInTenant } from '@/server/modules/Tenant/gate';
import { getTenantRuntime } from '@/server/modules/Tenant/runtime';
import { acceptGatewayCallback } from '@/server/services/gatewayAuthorization/attempts';
import { authorizeGateway } from '@/server/services/gatewayAuthorization/authorize';
import { finalizeGatewayOperation } from '@/server/services/gatewayAuthorization/finalize';
import type {
  GatewayAuthorizeRequest,
  GatewayCallback,
  GatewayFinalizeRequest,
} from '@/server/services/gatewayAuthorization/types';
import {
  GatewayAuthorizationError,
  parseGatewayWire,
} from '@/server/services/gatewayAuthorization/wire';
import { isBearerSecret } from '@/server/utils/bearerAuth';
import { readBlobWithLimit } from '@/utils/readBlobWithLimit';

interface GatewayInternalDeps {
  admission: (
    tenantId: string,
  ) => ReturnType<ReturnType<typeof getTenantRuntime>['gatewayAdmission']>;
  authorize: typeof authorizeGateway;
  callback: typeof acceptGatewayCallback;
  finalize: typeof finalizeGatewayOperation;
  run: typeof runInTenant;
  serviceTokens: () => Array<string | undefined>;
}
export const createGatewayInternalApp = (overrides: Partial<GatewayInternalDeps> = {}) => {
  const deps: GatewayInternalDeps = {
    serviceTokens: () => [
      appEnv.AGENT_GATEWAY_SERVICE_TOKEN,
      gatewayEnv.DEVICE_GATEWAY_SERVICE_TOKEN,
    ],
    run: runInTenant,
    admission: (id) => getTenantRuntime().gatewayAdmission(id),
    authorize: authorizeGateway,
    callback: acceptGatewayCallback,
    finalize: finalizeGatewayOperation,
    ...overrides,
  };
  const app = new Hono().basePath('/api/internal/gateway');
  app.onError((error, c) => {
    const gate = tenantGateErrorOf(error);
    const code =
      error instanceof GatewayAuthorizationError
        ? error.code
        : (gate?.code ?? 'GATEWAY_AUTHORITY_UNAVAILABLE');
    const status =
      error instanceof GatewayAuthorizationError
        ? error.status
        : gate
          ? gate.toResponse().status
          : 503;
    if (code === 'GATEWAY_AUTHORITY_UNAVAILABLE')
      console.error('Gateway authority unavailable', error.name);
    return c.json(
      { tenancyProtocol: 1, error: { code, message: code } },
      status as 400 | 401 | 403 | 404 | 409 | 503,
    );
  });
  app.use('*', async (c, next) => {
    const tokens = deps.serviceTokens().filter((token): token is string => !!token);
    if (!tokens.length) throw new GatewayAuthorizationError('GATEWAY_AUTHORITY_UNAVAILABLE', 503);
    if (!tokens.some((token) => isBearerSecret(c.req.header('authorization'), token)))
      throw new GatewayAuthorizationError('UNAUTHORIZED');
    const tenantId = c.req.header('X-LobeHub-Tenant-Id');
    if (!tenantId) throw new GatewayAuthorizationError('TENANT_REQUIRED', 400);
    if (!/^[\w.:-]{1,128}$/.test(tenantId))
      throw new GatewayAuthorizationError('TENANT_INVALID', 400);
    if (c.req.header('X-LobeHub-Gateway-Tenancy') !== '1')
      throw new GatewayAuthorizationError('GATEWAY_TENANCY_REQUIRED', 426);
    c.header('Cache-Control', 'private, no-store');
    await next();
    if (c.res.ok) {
      c.header('X-LobeHub-Gateway-Tenancy', '1');
      c.header('X-LobeHub-Tenant-Id', tenantId);
    }
  });
  const inputFor = async <T extends { tenantId: string }>(
    definition: Parameters<typeof parseGatewayWire>[0],
    c: Context,
  ) => {
    if (Number(c.req.header('content-length') ?? 0) > 1024 * 1024)
      throw new GatewayAuthorizationError('INVALID_GATEWAY_MESSAGE', 400);
    let body: unknown;
    try {
      const raw = await (await readBlobWithLimit(new Response(c.req.raw.body), 1024 * 1024)).text();
      body = JSON.parse(raw);
    } catch {
      throw new GatewayAuthorizationError('INVALID_GATEWAY_MESSAGE', 400);
    }
    const input = parseGatewayWire<T>(definition, body);
    if (input.tenantId !== c.req.header('X-LobeHub-Tenant-Id'))
      throw new GatewayAuthorizationError('TENANT_MISMATCH', 403);
    if (
      'sourceAcceptedVersion' in input &&
      c.req.header('X-LobeHub-Tenant-Version') !== String(input.sourceAcceptedVersion)
    )
      throw new GatewayAuthorizationError('TENANT_EXECUTION_VERSION_STALE', 409);
    return input;
  };
  app.post('/admission', async (c) => {
    const input = await inputFor<{ tenantId: string }>('admissionRequest', c);
    return c.json(await deps.admission(input.tenantId));
  });
  app.post('/authorize', async (c) => {
    const input = await inputFor<GatewayAuthorizeRequest>('authorizeRequest', c);
    return c.json(await deps.run(input.tenantId, () => deps.authorize(input)));
  });
  app.post('/tool-result', async (c) => {
    const input = await inputFor<GatewayCallback>('callback', c);
    return c.json(await deps.run(input.tenantId, () => deps.callback(input)));
  });
  app.post('/finalize-abandoned', async (c) => {
    const input = await inputFor<GatewayFinalizeRequest>('finalizeRequest', c);
    return c.json(await deps.run(input.tenantId, () => deps.finalize(input)));
  });
  return app;
};
export const gatewayInternal = createGatewayInternalApp();
export default gatewayInternal;
