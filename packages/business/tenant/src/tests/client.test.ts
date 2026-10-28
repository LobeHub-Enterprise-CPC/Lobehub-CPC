import { afterEach, describe, expect, it } from 'vitest';

import {
  currentTenantRelativePath,
  getTenant,
  getTenantScopeId,
  initializeTenant,
  setRemoteTenantId,
  setRemoteTenantSlugs,
  tenantStorageKey,
  withCurrentTenantPath,
} from '../client';
import { resolveTenant } from '../resolve';

afterEach(() => {
  setRemoteTenantId(undefined);
  setRemoteTenantSlugs(undefined);
  initializeTenant(new URL('https://app.test/'));
});

describe('document tenant context', () => {
  it('keeps the entry tenant until a new document is initialized', () => {
    const address = new URL('https://app.test/orgs/acme/signin');
    initializeTenant(address);
    address.pathname = '/orgs/other/signin';

    expect(getTenant()).toEqual({ basePath: '/orgs/acme', slug: 'acme' });
    initializeTenant(address);
    expect(getTenant()).toEqual({ basePath: '/orgs/other', slug: 'other' });
  });

  it('clears the previous tenant on an unscoped document', () => {
    initializeTenant(new URL('https://app.test/orgs/acme/agent'));
    initializeTenant(new URL('https://app.test/signin'));
    expect(getTenant()).toBeNull();
  });

  it.each([
    ['https://app.test/orgs/acme/signin', '/orgs/acme'],
    ['https://chat.acme.test/signin', ''],
  ])('keeps the bootstrapped display name for %s', (href, basePath) => {
    const bootstrap = { basePath, name: 'Acme Inc.', slug: 'acme' };
    initializeTenant(new URL(href), bootstrap);
    expect(getTenant()).toEqual(bootstrap);
  });

  it('has no display name when the address is the only source', () => {
    initializeTenant(new URL('https://app.test/orgs/acme/signin'));
    expect(getTenant()?.name).toBeUndefined();
  });

  it.each(['/orgs/UPPER/agent', '/t', '/orgs/a/agent', '/agent'])('rejects %s', (path) => {
    expect(resolveTenant(new URL(path, 'https://app.test'))).toBeNull();
  });
});

describe('current tenant helpers', () => {
  it('prefixes app paths and storage keys with the document tenant', () => {
    initializeTenant(new URL('https://app.test/orgs/acme/agent'));

    expect(withCurrentTenantPath('/signin')).toBe('/orgs/acme/signin');
    expect(withCurrentTenantPath('/orgs/acme/signin')).toBe('/orgs/acme/signin');
    expect(tenantStorageKey('draft:agent-1')).toBe('t:acme:draft:agent-1');

    initializeTenant(new URL('https://app.test/orgs/other/agent'));
    expect(tenantStorageKey('draft:agent-1')).toBe('t:other:draft:agent-1');
  });

  it('leaves paths and keys untouched without a tenant', () => {
    expect(withCurrentTenantPath('/signin')).toBe('/signin');
    expect(tenantStorageKey('draft:agent-1')).toBe('draft:agent-1');
  });
});

describe('desktop renderer tenant partition', () => {
  // The desktop renderer is not served under /orgs/{slug}: browser-local state (drafts, tabs, caches)
  // is partitioned by the committed tenant id instead, or an organization switch would keep
  // showing the previous organization's local state.
  it('partitions storage keys by the committed tenant id', () => {
    setRemoteTenantId('tenant-a');
    expect(getTenantScopeId()).toBe('tenant-a');
    expect(tenantStorageKey('draft:agent-1')).toBe('t:tenant-a:draft:agent-1');

    setRemoteTenantId('tenant-b');
    expect(tenantStorageKey('draft:agent-1')).toBe('t:tenant-b:draft:agent-1');
  });

  it('leaves keys unscoped until a tenant is committed', () => {
    setRemoteTenantId(undefined);

    expect(getTenantScopeId()).toBeUndefined();
    expect(tenantStorageKey('draft:agent-1')).toBe('draft:agent-1');
  });

  it('uses the page tenant slug on a served page', () => {
    initializeTenant(new URL('https://app.test/orgs/acme/agent'));

    expect(getTenantScopeId()).toBe('acme');
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
    expect(currentTenantRelativePath('/orgs/beta/api/auth')).toBeNull();
    expect(
      resolveTenant(new URL('https://chat.example.com/orgs/beta'), { slug: 'acme', basePath: '' }),
    ).toBeNull();
  });
});

describe('former slugs', () => {
  // Links written before a rename keep the slug the tenant had then; they still address it.
  it('treats a former slug of the page tenant as its own', () => {
    initializeTenant(new URL('https://app.test/orgs/acme/agent'), {
      basePath: '/orgs/acme',
      formerSlugs: ['acme-old'],
      slug: 'acme',
    });
    expect(currentTenantRelativePath('/orgs/acme-old/f/file_1')).toBe('/f/file_1');
    expect(currentTenantRelativePath('/t/acme-old/f/file_1')).toBe('/f/file_1');
    expect(currentTenantRelativePath('/orgs/acme/f/file_1')).toBe('/f/file_1');
    expect(currentTenantRelativePath('/orgs/beta/f/file_1')).toBeNull();
    expect(currentTenantRelativePath('/f/file_1')).toBeNull();
  });

  it('treats every slug of the desktop remote tenant as its own', () => {
    setRemoteTenantSlugs(['acme', 'acme-old']);
    expect(currentTenantRelativePath('/orgs/acme/f/file_1')).toBe('/f/file_1');
    expect(currentTenantRelativePath('/orgs/acme-old/f/file_1')).toBe('/f/file_1');
    expect(currentTenantRelativePath('/orgs/beta/f/file_1')).toBeNull();

    setRemoteTenantSlugs(undefined);
    expect(currentTenantRelativePath('/orgs/acme/f/file_1')).toBeNull();
  });
});
