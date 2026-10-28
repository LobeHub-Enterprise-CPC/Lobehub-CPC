import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useBusinessSignin } from './useBusinessSignin';

describe('useBusinessSignin', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reports an unavailable workspace separately from an SSO loading failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ code: 'TENANT_FROZEN' }, { status: 403 })),
    );

    const { result } = renderHook(() => useBusinessSignin());

    await waitFor(() => expect(result.current.tenantUnavailable).toBe(true));
    expect(result.current.ssoError).toBe(false);
  });

  it('keeps other failures as a retryable SSO loading error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    const { result } = renderHook(() => useBusinessSignin());

    await waitFor(() => expect(result.current.ssoError).toBe(true));
    expect(result.current.tenantUnavailable).toBe(false);
  });
});
