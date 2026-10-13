/**
 * @vitest-environment happy-dom
 */
import { initializeTenant } from '@lobechat/business-tenant/client';
import type * as LobechatConstModule from '@lobechat/const';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useElectronStore } from '@/store/electron';

import { buildAppUrl, getAppBaseUrl, resolveAppUrl } from '../appBaseUrl';

const env = vi.hoisted(() => ({ isDesktop: false }));

vi.mock('@lobechat/const', async (importOriginal) => {
  const actual = await importOriginal<typeof LobechatConstModule>();
  return {
    ...actual,
    get isDesktop() {
      return env.isDesktop;
    },
  };
});

const setRemote = (remoteServerUrl: string) =>
  useElectronStore.setState({
    dataSyncConfig: { remoteServerUrl, storageMode: 'selfHost' } as any,
  });

afterEach(() => {
  env.isDesktop = false;
  initializeTenant(new URL(window.location.href));
});

describe('getAppBaseUrl', () => {
  it('is the page origin plus the tenant path on the default entry', () => {
    initializeTenant(new URL(`${window.location.origin}/t/acme/agent`));

    expect(getAppBaseUrl()).toBe(`${window.location.origin}/t/acme`);
  });

  it('is the bare page origin on a custom-domain entry', () => {
    initializeTenant(new URL(`${window.location.origin}/agent`), { basePath: '', slug: 'acme' });

    expect(getAppBaseUrl()).toBe(window.location.origin);
  });

  it('is the configured remote tenant address on desktop', () => {
    env.isDesktop = true;
    setRemote('https://host.example/t/acme/');

    expect(getAppBaseUrl()).toBe('https://host.example/t/acme');
  });
});

describe('resolveAppUrl', () => {
  it('mounts a server-relative path under the tenant path on web', () => {
    initializeTenant(new URL(`${window.location.origin}/t/acme/community`));

    expect(resolveAppUrl('/webapi/user/avatar/u1/a.png')).toBe(
      `${window.location.origin}/t/acme/webapi/user/avatar/u1/a.png`,
    );
  });

  it('mounts a server-relative path under the remote tenant address on desktop', () => {
    env.isDesktop = true;
    setRemote('https://host.example/t/acme');

    expect(resolveAppUrl('/f/file_1')).toBe('https://host.example/t/acme/f/file_1');
  });

  it('passes absolute, protocol-relative and data URLs through', () => {
    initializeTenant(new URL(`${window.location.origin}/t/acme/community`));

    for (const value of [
      'https://files.example/logo.png',
      '//cdn.example/logo.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(resolveAppUrl(value)).toBe(value);
    }
  });
});

describe('buildAppUrl', () => {
  it('addresses an app page under the tenant path, query kept', () => {
    initializeTenant(new URL(`${window.location.origin}/t/acme/settings`));

    expect(buildAppUrl('/oauth/callback/success?provider=linear')).toBe(
      `${window.location.origin}/t/acme/oauth/callback/success?provider=linear`,
    );
  });

  it('addresses an app page at the root of a custom-domain entry', () => {
    initializeTenant(new URL(`${window.location.origin}/settings`), { basePath: '', slug: 'acme' });

    expect(buildAppUrl('/market-auth-callback')).toBe(
      `${window.location.origin}/market-auth-callback`,
    );
  });
});
