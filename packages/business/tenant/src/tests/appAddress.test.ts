import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appRelativePath,
  buildAppUrl,
  getAppBaseUrl,
  initializeTenant,
  resolveAppUrl,
  setRemoteAppAddress,
  useAppBaseUrl,
} from '../client';

const origin = () => window.location.origin;

afterEach(() => {
  setRemoteAppAddress(undefined);
  initializeTenant(new URL(window.location.href));
});

describe('getAppBaseUrl', () => {
  it("is the tenant's active address the server bootstrapped into the page", () => {
    initializeTenant(new URL(`${origin()}/agent`), {
      basePath: '',
      publicUrl: 'https://chat.acme.example/',
      slug: 'acme',
    });

    expect(getAppBaseUrl()).toBe('https://chat.acme.example');
  });

  it('is the page origin plus the tenant path without a bootstrap', () => {
    initializeTenant(new URL(`${origin()}/t/acme/agent`));

    expect(getAppBaseUrl()).toBe(`${origin()}/t/acme`);
  });

  it('is the configured remote address when the app is not served by the server', () => {
    setRemoteAppAddress('https://host.example/t/acme/');

    expect(getAppBaseUrl()).toBe('https://host.example/t/acme');
  });

  it('is empty while the remote address is not configured, never the renderer origin', () => {
    setRemoteAppAddress('');

    expect(getAppBaseUrl()).toBe('');
  });
});

describe('app URL helpers', () => {
  it('builds an app page URL under the active address, query kept', () => {
    initializeTenant(new URL(`${origin()}/t/acme/settings`));

    expect(buildAppUrl('/oauth/callback/success?provider=linear')).toBe(
      `${origin()}/t/acme/oauth/callback/success?provider=linear`,
    );
  });

  it('builds at the root of a custom-domain entry', () => {
    initializeTenant(new URL(`${origin()}/settings`), { basePath: '', slug: 'acme' });

    expect(buildAppUrl('/market-auth-callback')).toBe(`${origin()}/market-auth-callback`);
  });

  it('mounts a server-relative path and passes absolute values through', () => {
    setRemoteAppAddress('https://host.example/t/acme');

    expect(resolveAppUrl('/f/file_1')).toBe('https://host.example/t/acme/f/file_1');
    for (const value of [
      'https://files.example/a.png',
      '//cdn.example/a.png',
      'data:image/png;base64,AA',
    ])
      expect(resolveAppUrl(value)).toBe(value);
  });

  it('reads the app path of a URL path under the active address', () => {
    setRemoteAppAddress('https://host.example/t/acme');

    expect(appRelativePath('/t/acme/f/file_1')).toBe('/f/file_1');
    expect(appRelativePath('/t/beta/f/file_1')).toBeNull();
  });
});

describe('useAppBaseUrl', () => {
  it('follows the remote address as it is configured', () => {
    setRemoteAppAddress('');
    const { result, rerender } = renderHook(() => useAppBaseUrl());
    expect(result.current).toBe('');

    setRemoteAppAddress('https://host.example/t/acme');
    rerender();

    expect(result.current).toBe('https://host.example/t/acme');
  });

  it('keeps the tenant path on the web so appended app paths stay in the tenant', () => {
    initializeTenant(new URL(`${origin()}/t/acme/agent`));

    const { result } = renderHook(() => useAppBaseUrl());

    expect(`${result.current}/agent/a1`).toBe(`${origin()}/t/acme/agent/a1`);
  });
});
