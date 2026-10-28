import { describe, expect, it } from 'vitest';

import { buildTenantEntryUrl, tenantAppPath } from '../routing';

const acme = { publicUrl: 'https://host.example/orgs/acme', slug: 'acme' };
const custom = { publicUrl: 'https://chat.acme.example/', slug: 'acme' };

describe('buildTenantEntryUrl', () => {
  it('mounts an app path on the active entry, query kept', () => {
    expect(buildTenantEntryUrl(acme, '/oauth/callback/success?provider=x')).toBe(
      'https://host.example/orgs/acme/oauth/callback/success?provider=x',
    );
    expect(buildTenantEntryUrl(custom, '/api/auth/callback/okta')).toBe(
      'https://chat.acme.example/api/auth/callback/okta',
    );
    expect(buildTenantEntryUrl(custom, '/')).toBe('https://chat.acme.example');
  });

  it("accepts this tenant's own /orgs/{slug} form, never another tenant's", () => {
    expect(buildTenantEntryUrl(custom, '/orgs/acme/f/file_1')).toBe(
      'https://chat.acme.example/f/file_1',
    );
    expect(() => buildTenantEntryUrl(acme, '/orgs/beta/f/file_1')).toThrow();
  });

  it.each(['f/x', '//evil.example/x', '/a/../../orgs/beta', '/a/%2e%2e/x', '/a%2fb'])(
    'rejects %s',
    (path) => {
      expect(() => tenantAppPath(path, 'acme')).toThrow();
    },
  );
});
