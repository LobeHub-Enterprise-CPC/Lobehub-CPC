import { initializeTenant } from '@lobechat/business-tenant/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSwitchOrganizationUrl } from './switchOrganization';

const setServerConfig = (config: Record<string, unknown> | undefined) => {
  Object.defineProperty(window, '__SERVER_CONFIG__', {
    configurable: true,
    value: config,
    writable: true,
  });
};

describe('getSwitchOrganizationUrl', () => {
  beforeEach(() => {
    initializeTenant(new URL('https://app.example.com/t/acme/signin'));
  });

  afterEach(() => {
    initializeTenant(new URL('https://app.example.com/'));
    setServerConfig(undefined);
  });

  it('points at the deployment root with the lookup page forced open', () => {
    setServerConfig({ appUrl: 'https://app.example.com/' });

    expect(getSwitchOrganizationUrl()).toBe('https://app.example.com/?switch=1');
  });

  it('is absent while the server config has no appUrl, or a malformed one', () => {
    setServerConfig({});
    expect(getSwitchOrganizationUrl()).toBeNull();

    setServerConfig({ appUrl: 'javascript:alert(1)' });
    expect(getSwitchOrganizationUrl()).toBeNull();

    setServerConfig({ appUrl: 42 });
    expect(getSwitchOrganizationUrl()).toBeNull();
  });

  it('is absent on the lookup page itself, which belongs to no organization', () => {
    initializeTenant(new URL('https://app.example.com/'));
    setServerConfig({ appUrl: 'https://app.example.com' });

    expect(getSwitchOrganizationUrl()).toBeNull();
    expect(getSwitchOrganizationUrl({ originFallback: true })).toBeNull();
  });

  it('falls back to the page origin only for a path-addressed organization', () => {
    setServerConfig({});
    expect(getSwitchOrganizationUrl({ originFallback: true })).toBe(
      `${window.location.origin}/?switch=1`,
    );

    // A custom domain is the organization itself; its origin is not the deployment root.
    initializeTenant(new URL('https://acme.example.org/signin'), {
      basePath: '',
      slug: 'acme',
    });
    expect(getSwitchOrganizationUrl({ originFallback: true })).toBeNull();
  });

  it('points a custom-domain organization at the deployment root when appUrl is known', () => {
    initializeTenant(new URL('https://acme.example.org/signin'), { basePath: '', slug: 'acme' });
    setServerConfig({ appUrl: 'https://app.example.com' });

    expect(getSwitchOrganizationUrl()).toBe('https://app.example.com/?switch=1');
    expect(getSwitchOrganizationUrl({ originFallback: true })).toBe(
      'https://app.example.com/?switch=1',
    );
  });

  it('prefers the configured appUrl over the page origin', () => {
    setServerConfig({ appUrl: 'https://root.example.com' });

    expect(getSwitchOrganizationUrl({ originFallback: true })).toBe(
      'https://root.example.com/?switch=1',
    );
  });
});
