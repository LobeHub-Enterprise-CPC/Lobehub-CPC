import { afterEach, describe, expect, it } from 'vitest';

import {
  currentTenantRelativePath,
  getTenant,
  initializeTenant,
  tenantStorageKey,
  withCurrentTenantPath,
} from '../client';
import { resolveTenant } from '../resolve';

afterEach(() => initializeTenant(new URL('https://app.test/')));

describe('document tenant context', () => {
  it('keeps the entry tenant until a new document is initialized', () => {
    const address = new URL('https://app.test/t/acme/signin');
    initializeTenant(address);
    address.pathname = '/t/other/signin';

    expect(getTenant()).toEqual({ basePath: '/t/acme', slug: 'acme' });
    initializeTenant(address);
    expect(getTenant()).toEqual({ basePath: '/t/other', slug: 'other' });
  });

  it('clears the previous tenant on an unscoped document', () => {
    initializeTenant(new URL('https://app.test/t/acme/agent'));
    initializeTenant(new URL('https://app.test/signin'));
    expect(getTenant()).toBeNull();
  });

  it.each([
    ['https://app.test/t/acme/signin', '/t/acme'],
    ['https://chat.acme.test/signin', ''],
  ])('keeps the bootstrapped display name for %s', (href, basePath) => {
    const bootstrap = { basePath, name: 'Acme Inc.', slug: 'acme' };
    initializeTenant(new URL(href), bootstrap);
    expect(getTenant()).toEqual(bootstrap);
  });

  it('has no display name when the address is the only source', () => {
    initializeTenant(new URL('https://app.test/t/acme/signin'));
    expect(getTenant()?.name).toBeUndefined();
  });

  it.each(['/t/UPPER/agent', '/t', '/t/a/agent', '/agent'])('rejects %s', (path) => {
    expect(resolveTenant(new URL(path, 'https://app.test'))).toBeNull();
  });
});

describe('current tenant helpers', () => {
  it('prefixes app paths and storage keys with the document tenant', () => {
    initializeTenant(new URL('https://app.test/t/acme/agent'));

    expect(withCurrentTenantPath('/signin')).toBe('/t/acme/signin');
    expect(withCurrentTenantPath('/t/acme/signin')).toBe('/t/acme/signin');
    expect(tenantStorageKey('draft:agent-1')).toBe('t:acme:draft:agent-1');

    initializeTenant(new URL('https://app.test/t/other/agent'));
    expect(tenantStorageKey('draft:agent-1')).toBe('t:other:draft:agent-1');
  });

  it('leaves paths and keys untouched without a tenant', () => {
    expect(withCurrentTenantPath('/signin')).toBe('/signin');
    expect(tenantStorageKey('draft:agent-1')).toBe('draft:agent-1');
  });
});

describe('custom host bootstrap', () => {
  it('keeps root navigation and rejects other tenant paths', () => {
    initializeTenant(new URL('https://chat.example.com/agent'), {
      slug: 'acme',
      basePath: '',
    });
    expect(getTenant()).toEqual({ slug: 'acme', basePath: '' });
    expect(withCurrentTenantPath('/api/auth')).toBe('/api/auth');
    expect(currentTenantRelativePath('/agent')).toBe('/agent');
    expect(currentTenantRelativePath('/t/beta/api/auth')).toBeNull();
    expect(
      resolveTenant(new URL('https://chat.example.com/t/beta'), { slug: 'acme', basePath: '' }),
    ).toBeNull();
  });
});
