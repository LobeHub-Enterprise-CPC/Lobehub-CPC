// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { inProcessWorkCount } from './inProcessWork';
import { deliverMemoryInProcess } from './memoryDelivery';
import { verifyDeliveryRequest } from './signature';
import type { DeliveryInput } from './types';

const mocks = vi.hoisted(() => ({
  enter: vi.fn(),
  handle: vi.fn(),
  tenant: undefined as string | undefined,
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.com', INTERNAL_APP_URL: 'http://cpc-internal:3210' },
}));

// The tenant entry needs the platform database; record which tenant it was asked for.
vi.mock('@/server/modules/Tenant/gate', () => ({
  runInTenantSlug: async (slug: string, operation: () => Promise<unknown>) => {
    await mocks.enter(slug);
    mocks.tenant = slug;
    try {
      return await operation();
    } finally {
      mocks.tenant = undefined;
    }
  },
}));

// Stands in for the memory routes: answers as the test says, from inside the tenant.
vi.mock('@/server/router-hono/workflows/memory-user-memory', async () => {
  const { Hono } = await import('hono');
  const app = new Hono();
  app.post('/*', async (c) => mocks.handle(c.req.raw, await c.req.text(), mocks.tenant));
  return { default: app };
});

const memoryUrl =
  'https://app.example.com/orgs/acme/api/workflows/memory-user-memory/pipelines/chat-topic/process-user-topics';
const input = (overrides: Partial<DeliveryInput> = {}): DeliveryInput => ({
  body: '{"workflow":{}}',
  dedupKey: 'dedup-1',
  headers: { 'Content-Type': 'application/json' },
  retries: 3,
  tenantKey: 'acme',
  timeoutMs: 60_000,
  url: memoryUrl,
  ...overrides,
});
const attempt = { attempt: 0, messageId: 'run-1' };

describe('deliverMemoryInProcess', () => {
  beforeEach(() => {
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('INTERNAL_APP_URL', 'http://cpc-internal:3210');
    vi.stubEnv('DELIVERY_SIGNING_KEY', 'memory-test-key');
    mocks.enter.mockResolvedValue(undefined);
    mocks.handle.mockImplementation(() => Response.json({ status: 'done' }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it('serves a signed memory delivery inside the tenant named by its address', async () => {
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toEqual({
      kind: 'delivered',
      status: 200,
    });

    expect(mocks.enter).toHaveBeenCalledWith('acme');
    const [request, body, tenant] = mocks.handle.mock.calls[0];
    expect(tenant).toBe('acme');
    // Upstash Workflow schedules the next step at the address it serves: keep the tenant one.
    expect(request.url).toBe(memoryUrl);
    expect(body).toBe('{"workflow":{}}');
    expect(verifyDeliveryRequest(request, body)).toBe(true);
    expect(request.headers.get('Upstash-Retried')).toBe('0');
  });

  it('refuses addresses other than memory workflows of this app, and a tenant other than the run’s', async () => {
    for (const refused of [
      input({ tenantKey: 'other' }),
      input({ url: 'https://app.example.com/orgs/acme/api/workflows/goal/advance' }),
      input({ url: 'https://evil.example.com/orgs/acme/api/workflows/memory-user-memory/x' }),
      input({ url: 'https://app.example.com/api/workflows/memory-user-memory/x', tenantKey: '_' }),
      input({ url: 'not a url' }),
    ]) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(deliverMemoryInProcess(refused, attempt)).resolves.toEqual({
        kind: 'failed',
        reason: 'InvalidInput',
      });
      error.mockRestore();
    }
    expect(mocks.enter).not.toHaveBeenCalled();
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it('maps the route’s answers as an HTTP delivery would', async () => {
    mocks.handle.mockImplementationOnce(() =>
      Response.json({ status: 'busy' }, { headers: { 'Retry-After': '90' }, status: 409 }),
    );
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toMatchObject({
      afterMs: 90_000,
      kind: 'retry',
      status: 409,
    });

    mocks.handle.mockImplementationOnce(() =>
      Response.json({}, { headers: { 'Upstash-NonRetryable-Error': 'true' }, status: 400 }),
    );
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toMatchObject({
      kind: 'failed',
      status: 400,
    });

    mocks.handle.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toMatchObject({
      kind: 'retry',
      status: 500,
    });
  });

  it('answers a tenant refusal with its gate status', async () => {
    mocks.enter.mockRejectedValueOnce(new TenantGateError('TENANT_FROZEN'));
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toMatchObject({
      kind: 'retry',
      status: 403,
    });

    mocks.enter.mockRejectedValueOnce(new TenantGateError('TENANT_UNAVAILABLE'));
    await expect(deliverMemoryInProcess(input(), attempt)).resolves.toMatchObject({
      afterMs: 5000,
      kind: 'retry',
      status: 503,
    });
    expect(mocks.handle).not.toHaveBeenCalled();
  });

  it('ends a timed-out attempt but keeps the handler counted until it finishes', async () => {
    let finish!: () => void;
    mocks.handle.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = () => resolve(Response.json({ status: 'done' }));
        }),
    );

    await expect(deliverMemoryInProcess(input({ timeoutMs: 20 }), attempt)).resolves.toMatchObject({
      kind: 'retry',
      reason: 'TimeoutError',
    });
    expect(inProcessWorkCount()).toBe(1);

    finish();
    await vi.waitFor(() => expect(inProcessWorkCount()).toBe(0));
  });
});
