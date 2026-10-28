/**
 * Account-mode branch of the root page: the remembered-account confirm card.
 * The ordinary finder behaviour is covered in `index.test.tsx` and `useOrganizationDiscovery.test.ts`.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TenantDiscovery from './index';

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

const mockFetch = vi.fn();
const originalLocation = window.location;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status: 200,
    ...init,
  });

const acme = { id: 'tenant-acme', name: 'Acme' };
const globex = { address: 'app.example.com/t/globex', id: 'tenant-globex', name: 'Globex' };
const globexTwin = { address: 'globex.example.org', id: 'tenant-globex-2', name: 'Globex' };

const accountBody = (overrides = {}) => ({
  email: 'A@Acme.com',
  lastTenantId: 'tenant-globex',
  organizations: [acme, globex, globexTwin],
  ...overrides,
});

const setServerConfig = (config: unknown) =>
  Object.defineProperty(window, '__SERVER_CONFIG__', {
    configurable: true,
    value: config,
    writable: true,
  });

const accountCalls = () =>
  mockFetch.mock.calls.map(([url, init]) => ({
    body: JSON.parse((init as RequestInit).body as string),
    url: url as string,
  }));

describe('TenantDiscovery in account mode', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    localStorage.setItem(AGREEMENT_KEY, 'true');
    vi.stubGlobal('fetch', mockFetch);
    setServerConfig({ rootAccount: true });
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, href: 'http://localhost/', search: '' },
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    setServerConfig(undefined);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
  });

  it('shows a skeleton while loading, then the card with the email and the organizations', async () => {
    let resolveAccount!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveAccount = resolve)));
    render(<TenantDiscovery />);

    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('organization.account.loading')).toBeTruthy();
    expect(screen.getByText('organization.account.subtitle')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    await act(async () => resolveAccount(json(accountBody())));
    expect(await screen.findByText('A@Acme.com')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('organization.account.lastUsed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'organization.account.continue' })).toBeTruthy();
    expect(screen.getByText('organization.account.others')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'organization.account.useAnother' })).toBeTruthy();
    // Same card voice as the finder page, with the confirm copy.
    expect(screen.getByText('signin.subtitle', { exact: false })).toBeTruthy();
    expect(screen.getByText('organization.account.subtitle')).toBeTruthy();
    expect(screen.queryByText('organization.discovery.subtitle')).toBeNull();
  });

  it('continues into the last-used organization with its id and follows the entry URL exactly', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json(accountBody()));
    render(<TenantDiscovery />);
    await screen.findByText('A@Acme.com');

    mockFetch.mockResolvedValueOnce(
      json({ url: 'https://app.example.com/t/globex/__entry?signin=1' }),
    );
    await user.click(screen.getByRole('button', { name: 'organization.account.continue' }));

    await waitFor(() =>
      expect(window.location.href).toBe('https://app.example.com/t/globex/__entry?signin=1'),
    );
    expect(accountCalls()[1]).toEqual({
      body: { id: 'tenant-globex' },
      url: '/api/tenant-discovery/account/select',
    });
  });

  it('selects another organization from the list with the keyboard', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json(accountBody()));
    render(<TenantDiscovery />);
    await screen.findByText('A@Acme.com');

    const acmeRow = screen.getByRole('button', { name: /^Acme/ });
    acmeRow.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /globex\.example\.org/ }),
    );
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(acmeRow);
    expect(acmeRow.querySelector('svg')).not.toBeNull();

    mockFetch.mockResolvedValueOnce(json({ url: 'https://acme.example.org/__entry?signin=1' }));
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(window.location.href).toBe('https://acme.example.org/__entry?signin=1'),
    );
    expect(accountCalls()[1].body).toEqual({ id: 'tenant-acme' });
  });

  it('disables every action while one organization is being entered', async () => {
    const user = userEvent.setup();
    let resolveSelect!: (response: Response) => void;
    mockFetch.mockResolvedValueOnce(json(accountBody()));
    render(<TenantDiscovery />);
    await screen.findByText('A@Acme.com');

    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveSelect = resolve)));
    await user.click(screen.getByRole('button', { name: 'organization.account.continue' }));

    const continueButton = screen.getByRole('button', { name: 'organization.account.continue' });
    await waitFor(() => expect(continueButton.getAttribute('disabled')).not.toBeNull());
    expect(
      screen
        .getByRole('button', { name: 'organization.account.useAnother' })
        .getAttribute('disabled'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Acme/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );

    await act(async () => resolveSelect(json({ url: 'https://app.example.com/t/globex/__entry' })));
    await waitFor(() =>
      expect(window.location.href).toBe('https://app.example.com/t/globex/__entry'),
    );
  });

  it('marks an unavailable organization and keeps the others usable', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json(accountBody()));
    render(<TenantDiscovery />);
    await screen.findByText('A@Acme.com');

    mockFetch.mockResolvedValueOnce(json({ code: 'TENANT_NOT_AVAILABLE' }, { status: 404 }));
    await user.click(screen.getByRole('button', { name: /^Acme/ }));

    expect(await screen.findByText('organization.discovery.notAvailable')).toBeTruthy();
    const acmeRow = screen.getByRole('button', { name: /^Acme/ });
    expect(acmeRow.getAttribute('aria-disabled')).toBe('true');
    expect(acmeRow.textContent).toContain('organization.picker.itemUnavailable');
    expect(acmeRow.querySelector('svg')).toBeNull();

    mockFetch.mockResolvedValueOnce(json({ url: 'https://globex.example.org/__entry?signin=1' }));
    await user.click(screen.getByRole('button', { name: /globex\.example\.org/ }));
    await waitFor(() =>
      expect(window.location.href).toBe('https://globex.example.org/__entry?signin=1'),
    );
  });

  it('renders no highlighted item and no primary button when there is no last-used organization', async () => {
    mockFetch.mockResolvedValueOnce(json(accountBody({ lastTenantId: null })));
    render(<TenantDiscovery />);

    expect(await screen.findByText('A@Acme.com')).toBeTruthy();
    expect(screen.queryByText('organization.account.lastUsed')).toBeNull();
    expect(screen.queryByRole('button', { name: 'organization.account.continue' })).toBeNull();
    expect(screen.getByText('organization.account.others')).toBeTruthy();
    // Every organization is in the list now.
    expect(screen.getByRole('button', { name: /^Acme/ })).toBeTruthy();
  });

  it.each([[204], [409]])('falls back to the finder form in place on %s', async (status) => {
    mockFetch.mockResolvedValueOnce(
      status === 204
        ? new Response(null, { status: 204 })
        : json({ code: 'ACCOUNT_MEMORY_MISSING' }, { status: 409 }),
    );
    render(<TenantDiscovery />);

    expect(
      await screen.findByRole('textbox', { name: 'organization.discovery.emailLabel' }),
    ).toBeTruthy();
    expect(screen.getByText('organization.discovery.subtitle')).toBeTruthy();
    expect(screen.queryByText('organization.account.subtitle')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses another account: forgets first, then goes to /?switch=1 even when forget fails', async () => {
    const user = userEvent.setup();
    mockFetch
      .mockResolvedValueOnce(json(accountBody()))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(<TenantDiscovery />);
    await screen.findByText('A@Acme.com');

    await user.click(screen.getByRole('button', { name: 'organization.account.useAnother' }));

    await waitFor(() => expect(window.location.href).toBe('/?switch=1'));
    expect(accountCalls()[1]).toEqual({ body: {}, url: '/api/tenant-discovery/account/forget' });
  });

  it('shows the failure and retries in place after a 503', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      json({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, { status: 503 }),
    );
    render(<TenantDiscovery />);

    expect(await screen.findByText('organization.discovery.unavailable')).toBeTruthy();
    expect(screen.queryByText('A@Acme.com')).toBeNull();

    mockFetch.mockResolvedValueOnce(json(accountBody()));
    await user.click(screen.getByRole('button', { name: 'organization.account.retry' }));
    expect(await screen.findByText('A@Acme.com')).toBeTruthy();
  });

  it('counts a rate limit down and hands the retry back when it elapses', async () => {
    mockFetch.mockResolvedValueOnce(
      json({ code: 'RATE_LIMITED' }, { headers: { 'Retry-After': '2' }, status: 429 }),
    );
    render(<TenantDiscovery />);

    expect(
      await screen.findByText('organization.discovery.rateLimited {"seconds":2}'),
    ).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'organization.account.retry' });
    expect(retry.getAttribute('disabled')).not.toBeNull();

    // The alert ticks down while the action stays disabled.
    expect(
      await screen.findByText('organization.discovery.rateLimited {"seconds":1}'),
    ).toBeTruthy();
    expect(retry.getAttribute('disabled')).not.toBeNull();

    // When the seconds run out the retry action is handed back.
    await waitFor(() => expect(retry.getAttribute('disabled')).toBeNull(), { timeout: 3000 });
    expect(screen.getByText('organization.discovery.rateLimitedGeneric')).toBeTruthy();

    mockFetch.mockResolvedValueOnce(json(accountBody()));
    fireEvent.click(retry);
    expect(await screen.findByText('A@Acme.com')).toBeTruthy();
  }, 15000);

  it('stays in the finder when the desktop client opened the page, even with the flag', async () => {
    setServerConfig({ desktopFlow: { status: 'ready' }, rootAccount: true });
    window.location.search = `?client=desktop&state=${STATE}&code_challenge=${CHALLENGE}`;
    render(<TenantDiscovery />);

    expect(screen.getByText('organization.desktop.subtitle')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'organization.discovery.emailLabel' })).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
