import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopFlow } from './desktopFlow';
import { useOrganizationDiscovery } from './useOrganizationDiscovery';

// Show interpolation values so a test can see the number behind "try again in N seconds".
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

const AGREEMENT_KEY = 'lobehub:auth:agreement-accepted:v1';
const STATE = 'a'.repeat(32);
const CHALLENGE = 'B'.repeat(43);
const desktop: DesktopFlow = {
  fastPathUnavailable: false,
  kind: 'active',
  params: { codeChallenge: CHALLENGE, state: STATE },
};

const mockFetch = vi.fn();
const assign = vi.fn();
const originalLocation = window.location;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
    ...init,
  });

const acme = { id: 'tenant-acme', name: 'Acme' };
const globex = { address: 'app.example.com/t/globex', id: 'tenant-globex', name: 'Globex' };

const calls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    body: JSON.parse((init as RequestInit).body as string),
    url: url as string,
  }));

const submit = async (
  result: { current: ReturnType<typeof useOrganizationDiscovery> },
  email: string,
) => {
  await act(async () => {
    result.current.form.setValue('email', email);
    await result.current.form.submit();
  });
};

describe('useOrganizationDiscovery', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    assign.mockReset();
    localStorage.setItem(AGREEMENT_KEY, 'true');
    vi.stubGlobal('fetch', mockFetch);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign, href: originalLocation.href, search: '' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
  });

  describe('email validation', () => {
    it.each([
      ['', 'organization.discovery.emailRequired'],
      ['   ', 'organization.discovery.emailRequired'],
      ['not-an-email', 'organization.discovery.emailInvalid'],
      [`${'a'.repeat(250)}@x.io`, 'organization.discovery.emailInvalid'],
    ])('rejects %j', (value, message) => {
      const { result } = renderHook(() => useOrganizationDiscovery());

      expect(result.current.validateEmail(value)).toBe(message);
    });

    it('accepts an ordinary address', () => {
      const { result } = renderHook(() => useOrganizationDiscovery());

      expect(result.current.validateEmail(' A@Acme.com ')).toBeUndefined();
    });
  });

  describe('lookup', () => {
    it('asks the root lookup route with the normalised address', async () => {
      mockFetch.mockResolvedValueOnce(json({ tenants: [] }));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, ' Nobody@Example.com ');

      expect(calls()).toEqual([
        { body: { email: 'nobody@example.com' }, url: '/api/tenant-discovery' },
      ]);
    });

    it('opens the picker, not a redirect, for several organizations', async () => {
      mockFetch.mockResolvedValueOnce(json({ tenants: [acme, globex] }));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() => expect(result.current.pickerOpen).toBe(true));
      expect(result.current.organizations).toEqual([acme, globex]);
      expect(assign).not.toHaveBeenCalled();
    });

    it('goes straight on for exactly one organization, carrying the language', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(
          json({ url: 'https://app.example.com/t/acme/signin?email=a%40acme.com' }),
        );
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith(
          'https://app.example.com/t/acme/signin?email=a%40acme.com&hl=zh-CN',
        ),
      );
      expect(calls()[1]).toEqual({
        body: { email: 'a@acme.com', id: 'tenant-acme' },
        url: '/api/tenant-discovery/select',
      });
      expect(result.current.pickerOpen).toBe(false);
    });

    it('does not override a language the server already chose', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(json({ url: 'https://acme.example.org/signin?hl=en-US' }));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://acme.example.org/signin?hl=en-US'),
      );
    });

    it('refuses to navigate to anything but a web address', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(json({ url: 'javascript:alert(1)' }));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() =>
        expect(result.current.notice?.text).toBe('organization.discovery.unavailable'),
      );
      expect(assign).not.toHaveBeenCalled();
    });

    it('stays loading from the submit through to the navigation, with no gap', async () => {
      let resolveSelect!: (response: Response) => void;
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveSelect = resolve)));
      const busy: boolean[] = [];
      const { result } = renderHook(() => {
        const state = useOrganizationDiscovery();
        busy.push(state.searching || state.selectingId !== null);
        return state;
      });

      await submit(result, 'a@acme.com');
      await waitFor(() => expect(calls()).toHaveLength(2));
      await act(async () => resolveSelect(json({ url: 'https://app.example.com/t/acme/signin' })));
      await waitFor(() => expect(assign).toHaveBeenCalled());

      const firstBusy = busy.indexOf(true);
      expect(firstBusy).toBeGreaterThan(-1);
      expect(busy.slice(firstBusy)).not.toContain(false);
    });

    it('runs one lookup however many submits arrive while it is pending', async () => {
      let resolveLookup!: (response: Response) => void;
      mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveLookup = resolve)));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await act(async () => {
        result.current.form.setValue('email', 'a@acme.com');
        await Promise.all([
          result.current.form.submit(),
          result.current.form.submit(),
          result.current.form.submit(),
        ]);
      });
      await act(async () => resolveLookup(json({ tenants: [] })));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('asks to accept the terms first and sends nothing until they are', async () => {
      localStorage.removeItem(AGREEMENT_KEY);
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      expect(result.current.agreementChecked).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  it('hands the page back after returning through the back/forward cache mid-selection', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ tenants: [acme] }))
      .mockResolvedValueOnce(json({ url: 'https://app.example.com/t/acme/signin' }));
    const { result } = renderHook(() => useOrganizationDiscovery());
    await submit(result, 'a@acme.com');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(result.current.selectingId).toBe('tenant-acme');

    act(() => {
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });

    expect(result.current.selectingId).toBeNull();
    expect(result.current.searching).toBe(false);
  });

  describe('failures', () => {
    it('says how long to wait after a rate limit', async () => {
      mockFetch.mockResolvedValueOnce(
        json({ code: 'RATE_LIMITED' }, { headers: { 'Retry-After': '42' }, status: 429 }),
      );
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() =>
        expect(result.current.notice?.text).toBe(
          'organization.discovery.rateLimited {"seconds":42}',
        ),
      );
    });

    it('still reports a rate limit when the wait time is unreadable', async () => {
      mockFetch.mockResolvedValueOnce(
        json(
          { code: 'RATE_LIMITED' },
          { headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' }, status: 429 },
        ),
      );
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() =>
        expect(result.current.notice?.text).toBe('organization.discovery.rateLimitedGeneric'),
      );
    });

    it.each([
      [
        'service unavailable',
        () => json({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, { status: 503 }),
      ],
      ['network error', () => Promise.reject(new TypeError('Failed to fetch'))],
      ['unreadable body', () => new Response('<html>', { status: 200 })],
      ['malformed result', () => json({ tenants: [{ id: 1 }] })],
    ])('offers a retry after a %s, and the next submit works', async (_, respond) => {
      mockFetch.mockImplementationOnce(async () => respond());
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');
      await waitFor(() =>
        expect(result.current.notice?.text).toBe('organization.discovery.unavailable'),
      );
      expect(result.current.searching).toBe(false);

      mockFetch.mockResolvedValueOnce(json({ tenants: [acme, globex] }));
      await submit(result, 'a@acme.com');
      await waitFor(() => expect(result.current.pickerOpen).toBe(true));
    });

    it('lets an unavailable organization be skipped in favour of another', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme, globex] }))
        .mockResolvedValueOnce(json({ code: 'TENANT_NOT_AVAILABLE' }, { status: 404 }));
      const { result } = renderHook(() => useOrganizationDiscovery());
      await submit(result, 'a@acme.com');
      await waitFor(() => expect(result.current.pickerOpen).toBe(true));

      await act(async () => result.current.choose(acme));

      await waitFor(() =>
        expect(result.current.notice?.text).toBe('organization.discovery.notAvailable'),
      );
      expect(result.current.unavailableIds.has('tenant-acme')).toBe(true);
      expect(result.current.pickerOpen).toBe(true);
      expect(result.current.selectingId).toBeNull();

      mockFetch.mockResolvedValueOnce(json({ url: 'https://app.example.com/t/globex/signin' }));
      await act(async () => result.current.choose(globex));
      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://app.example.com/t/globex/signin?hl=zh-CN'),
      );
    });

    it('locks the picker while a choice is in flight', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme, globex] }))
        .mockReturnValueOnce(new Promise<Response>(() => {}));
      const { result } = renderHook(() => useOrganizationDiscovery());
      await submit(result, 'a@acme.com');
      await waitFor(() => expect(result.current.pickerOpen).toBe(true));

      await act(async () => {
        result.current.choose(acme);
        result.current.choose(globex);
      });

      expect(calls().filter(({ url }) => url.endsWith('/select'))).toHaveLength(1);
      expect(result.current.selectingId).toBe('tenant-acme');
      act(() => result.current.closePicker());
      expect(result.current.pickerOpen).toBe(true);
    });

    it('treats a server-side rejection of the address as a field problem, not a service failure', async () => {
      mockFetch.mockResolvedValueOnce(json({ code: 'INVALID_REQUEST' }, { status: 400 }));
      const { result } = renderHook(() => useOrganizationDiscovery());

      await submit(result, 'a@acme.com');

      await waitFor(() => expect(result.current.searching).toBe(false));
      expect(result.current.notice).toBeNull();
    });
  });

  describe('desktop sign-in', () => {
    it('sends the handoff parameters with select and follows the authorization URL as given', async () => {
      const authorizeUrl =
        'https://app.example.com/t/acme/oidc/auth?client_id=lobehub-desktop&state=' + STATE;
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(json({ url: authorizeUrl }));
      const { result } = renderHook(() => useOrganizationDiscovery(desktop));

      await submit(result, 'a@acme.com');

      await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
      expect(calls()[1].body).toEqual({
        desktop: { codeChallenge: CHALLENGE, state: STATE },
        email: 'a@acme.com',
        id: 'tenant-acme',
      });
      // No `hl`, no re-serialisation: byte for byte what the server returned.
      expect(assign).toHaveBeenCalledWith(authorizeUrl);
    });

    it('never sends a desktop block on an ordinary visit', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(json({ url: 'https://app.example.com/t/acme/signin' }));
      const { result } = renderHook(() => useOrganizationDiscovery({ kind: 'none' }));

      await submit(result, 'a@acme.com');
      await waitFor(() => expect(assign).toHaveBeenCalled());

      expect('desktop' in calls()[1].body).toBe(false);
    });

    it('ends the page on 409 HANDOFF_EXISTS: the request is spent, the form is not retried', async () => {
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme, globex] }))
        .mockResolvedValueOnce(json({ code: 'HANDOFF_EXISTS' }, { status: 409 }));
      const { result } = renderHook(() => useOrganizationDiscovery(desktop));
      await submit(result, 'a@acme.com');
      await waitFor(() => expect(result.current.pickerOpen).toBe(true));

      await act(async () => result.current.choose(acme));

      await waitFor(() => expect(result.current.blocked).toBe('expired'));
      expect(result.current.pickerOpen).toBe(false);
      expect(result.current.notice).toBeNull();
      expect(assign).not.toHaveBeenCalled();
    });

    it.each([
      [{ kind: 'blocked', reason: 'invalid' }, 'invalid'],
      [{ kind: 'blocked', reason: 'expired' }, 'expired'],
      [{ kind: 'none' }, null],
      [desktop, null],
    ] as const)('hides the form for %j: blocked=%s', (flow, blocked) => {
      const { result } = renderHook(() => useOrganizationDiscovery(flow as DesktopFlow));

      expect(result.current.blocked).toBe(blocked);
    });

    it('reads the flow from the server config and the URL when none is given', () => {
      window.location.search = `?client=desktop&state=${STATE}&code_challenge=${CHALLENGE}`;
      Object.defineProperty(window, '__SERVER_CONFIG__', {
        configurable: true,
        value: { desktopFlow: { status: 'ready' } },
        writable: true,
      });
      try {
        const { result } = renderHook(() => useOrganizationDiscovery());

        expect(result.current.desktopFlow).toEqual(desktop);
      } finally {
        Object.defineProperty(window, '__SERVER_CONFIG__', {
          configurable: true,
          value: undefined,
          writable: true,
        });
      }
    });
  });
});
