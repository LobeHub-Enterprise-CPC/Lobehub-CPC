/**
 * Component-level behaviour only: what the DOM does with focus, keyboard and the dialog.
 * Request, redirect and state-machine logic is covered in `useOrganizationDiscovery.test.ts`.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
const globexTwin = { address: 'globex.example.org', id: 'tenant-globex-2', name: 'Globex' };

const emailInput = () => screen.getByRole('textbox', { name: 'organization.discovery.emailLabel' });
const submit = () => screen.getByRole('button', { name: 'organization.discovery.submit' });

const submitEmail = async (user: ReturnType<typeof userEvent.setup>, value: string) => {
  await user.clear(emailInput());
  await user.type(emailInput(), value);
  await user.click(submit());
};

const setServerConfig = (config: unknown) =>
  Object.defineProperty(window, '__SERVER_CONFIG__', {
    configurable: true,
    value: config,
    writable: true,
  });

describe('TenantDiscovery', () => {
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
    setServerConfig(undefined);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
      writable: true,
    });
  });

  it('focuses the email field on arrival', () => {
    render(<TenantDiscovery />);

    expect(document.activeElement).toBe(emailInput());
  });

  it('looks the same as sign-in: title, terms checkbox, then the primary button', () => {
    const { container } = render(<TenantDiscovery />);

    expect(screen.getByText('signin.subtitle', { exact: false })).toBeTruthy();
    const form = container.querySelector('form')!;
    const order = [...form.querySelectorAll('input, button')].map((node) =>
      node.getAttribute('type') === 'checkbox' || node.getAttribute('role') === 'checkbox'
        ? 'terms'
        : node.tagName === 'INPUT'
          ? 'email'
          : 'submit',
    );
    expect(order).toEqual(['email', 'terms', 'submit']);
  });

  it('shows validation under the field and calls nobody', async () => {
    const user = userEvent.setup();
    render(<TenantDiscovery />);

    await user.click(submit());
    expect(await screen.findByText('organization.discovery.emailRequired')).toBeTruthy();

    await submitEmail(user, 'not-an-email');
    expect(await screen.findByText('organization.discovery.emailInvalid')).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('shows "no organization" under the field and keeps what the user typed', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(json({ tenants: [] }));
    render(<TenantDiscovery />);

    await submitEmail(user, 'Nobody@Example.com');

    expect(await screen.findByText('organization.discovery.notFound')).toBeTruthy();
    expect((emailInput() as HTMLInputElement).value).toBe('Nobody@Example.com');
  });

  it('shows a failure as an alert and clears it as soon as the user edits the email', async () => {
    const user = userEvent.setup();
    mockFetch.mockResolvedValueOnce(
      json({ code: 'TENANT_DISCOVERY_UNAVAILABLE' }, { status: 503 }),
    );
    render(<TenantDiscovery />);
    await submitEmail(user, 'a@acme.com');
    expect(await screen.findByText('organization.discovery.unavailable')).toBeTruthy();
    expect((emailInput() as HTMLInputElement).value).toBe('a@acme.com');

    await user.type(emailInput(), 'x');

    expect(screen.queryByText('organization.discovery.unavailable')).toBeNull();
  });

  it('keeps the button loading while the lookup runs', async () => {
    const user = userEvent.setup();
    let resolveLookup!: (response: Response) => void;
    mockFetch.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveLookup = resolve)));
    render(<TenantDiscovery />);

    await submitEmail(user, 'a@acme.com');

    await waitFor(() => expect(submit().getAttribute('aria-busy')).toBe('true'));
    await act(async () => resolveLookup(json({ tenants: [] })));
    await waitFor(() => expect(submit().getAttribute('aria-busy')).toBeNull());
  });

  describe('several organizations', () => {
    const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
      mockFetch.mockResolvedValueOnce(json({ tenants: [acme, globex, globexTwin] }));
      render(<TenantDiscovery />);
      await submitEmail(user, 'a@acme.com');
      return screen.findByRole('dialog');
    };

    it('lists every organization, with the address only where names collide', async () => {
      const dialog = await openPicker(userEvent.setup());

      const rows = within(dialog).getAllByRole('button', { name: /Acme|Globex/ });
      expect(rows.map((row) => row.textContent)).toEqual([
        'Acme',
        'Globexapp.example.com/t/globex',
        'Globexglobex.example.org',
      ]);
    });

    it('picks with the keyboard and continues to the chosen organization', async () => {
      const user = userEvent.setup();
      const dialog = await openPicker(user);
      mockFetch.mockResolvedValueOnce(json({ url: 'https://globex.example.org/signin' }));

      const rows = within(dialog).getAllByRole('button', { name: /Acme|Globex/ });
      rows[0].focus();
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(rows[1]);
      await user.keyboard('{ArrowDown}');
      expect(document.activeElement).toBe(rows[2]);
      await user.keyboard('{Enter}');

      await waitFor(() =>
        expect(assign).toHaveBeenCalledWith('https://globex.example.org/signin?hl=zh-CN'),
      );
    });

    it('closes without losing the email, and hands focus back to the field', async () => {
      const user = userEvent.setup();
      await openPicker(user);

      await user.keyboard('{Escape}');

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect((emailInput() as HTMLInputElement).value).toBe('a@acme.com');
      await waitFor(() => expect(document.activeElement).toBe(emailInput()));
      expect(assign).not.toHaveBeenCalled();
    });

    it('marks an unavailable organization inside the dialog and leaves the others pickable', async () => {
      const user = userEvent.setup();
      const dialog = await openPicker(user);
      mockFetch.mockResolvedValueOnce(json({ code: 'TENANT_NOT_AVAILABLE' }, { status: 404 }));

      await user.click(within(dialog).getByRole('button', { name: /^Acme/ }));

      expect(await within(dialog).findByText('organization.discovery.notAvailable')).toBeTruthy();
      const acmeRow = within(dialog).getByRole('button', { name: /^Acme/ });
      expect(acmeRow.getAttribute('aria-disabled')).toBe('true');
      expect(acmeRow.textContent).toContain('organization.picker.itemUnavailable');
      expect(
        within(dialog)
          .getByRole('button', { name: /app\.example\.com\/t\/globex/ })
          .getAttribute('aria-disabled'),
      ).toBeNull();
    });
  });

  describe('desktop sign-in', () => {
    const arrive = (status: string | undefined, search = '') => {
      setServerConfig(status ? { desktopFlow: { status } } : undefined);
      window.location.search = search;
    };
    const valid = `?client=desktop&state=${STATE}&code_challenge=${CHALLENGE}`;

    it('explains the desktop purpose and keeps the ordinary form', () => {
      arrive('ready', valid);

      render(<TenantDiscovery />);

      expect(screen.getByText('organization.desktop.subtitle')).toBeTruthy();
      expect(emailInput()).toBeTruthy();
      expect(screen.queryByText('organization.desktop.fastPathUnavailable')).toBeNull();
    });

    it('says the instant jump is unavailable, and still offers the form', () => {
      arrive('unavailable', valid);

      render(<TenantDiscovery />);

      expect(screen.getByText('organization.desktop.fastPathUnavailable')).toBeTruthy();
      expect(emailInput()).toBeTruthy();
    });

    it.each([
      ['invalid', valid, 'organization.desktop.invalid'],
      ['expired', valid, 'organization.desktop.expired'],
      ['ready', '?client=desktop&state=bad&code_challenge=bad', 'organization.desktop.invalid'],
    ])('replaces the form with a restart notice for %s (%s)', (status, search, message) => {
      arrive(status, search);

      render(<TenantDiscovery />);

      expect(screen.getByText(message)).toBeTruthy();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'organization.discovery.submit' })).toBeNull();
    });

    it('swaps the form for the restart notice when the request turns out to be spent', async () => {
      const user = userEvent.setup();
      arrive('ready', valid);
      mockFetch
        .mockResolvedValueOnce(json({ tenants: [acme] }))
        .mockResolvedValueOnce(json({ code: 'HANDOFF_EXISTS' }, { status: 409 }));
      render(<TenantDiscovery />);

      await submitEmail(user, 'a@acme.com');

      expect(await screen.findByText('organization.desktop.expired')).toBeTruthy();
      expect(screen.queryByRole('textbox')).toBeNull();
    });
  });
});
