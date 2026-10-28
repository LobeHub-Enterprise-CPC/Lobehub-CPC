import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appRelativePath,
  buildAppUrl,
  getAppBaseUrl,
  initializeTenant,
  resolveAppUrl,
  setRemoteAppAddress,
  useAppAssetUrl,
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
    initializeTenant(new URL(`${origin()}/orgs/acme/agent`));

    expect(getAppBaseUrl()).toBe(`${origin()}/orgs/acme`);
  });

  it('is the configured remote address when the app is not served by the server', () => {
    setRemoteAppAddress('https://host.example/orgs/acme/');

    expect(getAppBaseUrl()).toBe('https://host.example/orgs/acme');
  });

  it('is empty while the remote address is not configured, never the renderer origin', () => {
    setRemoteAppAddress('');

    expect(getAppBaseUrl()).toBe('');
  });
});

describe('app URL helpers', () => {
  it('builds an app page URL under the active address, query kept', () => {
    initializeTenant(new URL(`${origin()}/orgs/acme/settings`));

    expect(buildAppUrl('/oauth/callback/success?provider=linear')).toBe(
      `${origin()}/orgs/acme/oauth/callback/success?provider=linear`,
    );
  });

  it('builds at the root of a custom-domain entry', () => {
    initializeTenant(new URL(`${origin()}/settings`), { basePath: '', slug: 'acme' });

    expect(buildAppUrl('/market-auth-callback')).toBe(`${origin()}/market-auth-callback`);
  });

  it('mounts a server-relative path and passes absolute values through', () => {
    setRemoteAppAddress('https://host.example/orgs/acme');

    expect(resolveAppUrl('/f/file_1')).toBe('https://host.example/orgs/acme/f/file_1');
    for (const value of [
      'https://files.example/a.png',
      '//cdn.example/a.png',
      'data:image/png;base64,AA',
    ])
      expect(resolveAppUrl(value)).toBe(value);
  });

  it('reads the app path of a URL path under the active address', () => {
    setRemoteAppAddress('https://host.example/orgs/acme');

    expect(appRelativePath('/orgs/acme/f/file_1')).toBe('/f/file_1');
    expect(appRelativePath('/orgs/beta/f/file_1')).toBeNull();
  });
});

describe('useAppBaseUrl', () => {
  it('follows the remote address as it is configured', () => {
    setRemoteAppAddress('');
    const { result, rerender } = renderHook(() => useAppBaseUrl());
    expect(result.current).toBe('');

    setRemoteAppAddress('https://host.example/orgs/acme');
    rerender();

    expect(result.current).toBe('https://host.example/orgs/acme');
  });

  it('keeps the tenant path on the web so appended app paths stay in the tenant', () => {
    initializeTenant(new URL(`${origin()}/orgs/acme/agent`));

    const { result } = renderHook(() => useAppBaseUrl());

    expect(`${result.current}/agent/a1`).toBe(`${origin()}/orgs/acme/agent/a1`);
  });
});

describe('useAppAssetUrl', () => {
  it('mounts a server-relative asset under the remote address once it is configured', () => {
    setRemoteAppAddress('');
    const { result, rerender } = renderHook(() => useAppAssetUrl('/webapi/user/avatar/u1'));
    expect(result.current).toBe('/webapi/user/avatar/u1');

    setRemoteAppAddress('https://host.example/orgs/acme');
    rerender();

    expect(result.current).toBe('https://host.example/orgs/acme/webapi/user/avatar/u1');
  });

  it('keeps an absolute or missing value as it is', () => {
    setRemoteAppAddress('https://host.example/orgs/acme');

    expect(renderHook(() => useAppAssetUrl('https://cdn.example/a.png')).result.current).toBe(
      'https://cdn.example/a.png',
    );
    expect(renderHook(() => useAppAssetUrl(undefined)).result.current).toBeUndefined();
  });

  it('leaves the path to the DOM-level rewrite on a page the server served', () => {
    initializeTenant(new URL(`${origin()}/orgs/acme/agent`));

    expect(renderHook(() => useAppAssetUrl('/f/file_1')).result.current).toBe('/f/file_1');
  });
});
