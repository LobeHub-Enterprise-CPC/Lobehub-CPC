// @vitest-environment node
import type { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import { TenantGateError } from '@/server/modules/Tenant/errors';

import { POST } from './route';

const mocks = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('@/database/server', () => ({ serverDB: { select: mocks.select } }));

const request = () =>
  new Request('https://localhost/api/auth/resolve-username', {
    body: JSON.stringify({ username: 'user' }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  }) as NextRequest;

describe('/api/auth/resolve-username', () => {
  it('answers a tenant refusal raised by the database with its code', async () => {
    mocks.select.mockImplementationOnce(() => {
      throw new Error('Failed query', { cause: new TenantGateError('TENANT_OFFLINE') });
    });

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'TENANT_OFFLINE' });
  });

  it('keeps other failures as internal errors', async () => {
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    mocks.select.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const response = await POST(request());

    expect(response.status).toBe(500);
  });
});
