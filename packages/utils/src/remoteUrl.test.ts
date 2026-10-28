import { describe, expect, it } from 'vitest';

import {
  buildRemoteUrl,
  isUnderRemoteBase,
  normalizeRemoteBaseUrl,
  relativeToRemoteBase,
  resolveRemoteUrl,
} from './remoteUrl';

describe('buildRemoteUrl', () => {
  it.each([
    ['https://host/orgs/acme'],
    ['https://host/orgs/acme/'],
    ['https://host/orgs/acme//'],
    ['https://host/orgs/acme?x=1#frag'],
    [new URL('https://host/orgs/acme/')],
  ])('mounts an app path under the tenant base %s', (base) => {
    expect(buildRemoteUrl('/oidc/token', base).toString()).toBe(
      'https://host/orgs/acme/oidc/token',
    );
  });

  it('is equivalent to the origin-relative behaviour for a root base', () => {
    expect(buildRemoteUrl('/oidc/token', 'https://custom.host').toString()).toBe(
      'https://custom.host/oidc/token',
    );
    expect(buildRemoteUrl('/oidc/token', 'https://custom.host/').toString()).toBe(
      'https://custom.host/oidc/token',
    );
  });

  it('keeps the port of the base', () => {
    expect(buildRemoteUrl('/trpc', 'http://127.0.0.1:3210/orgs/acme').toString()).toBe(
      'http://127.0.0.1:3210/orgs/acme/trpc',
    );
  });

  it('keeps query and hash of the path', () => {
    expect(
      buildRemoteUrl('/trpc/lambda/a.b?batch=1&input=%7B%7D', 'https://host/orgs/acme').href,
    ).toBe('https://host/orgs/acme/trpc/lambda/a.b?batch=1&input=%7B%7D');
    expect(buildRemoteUrl('/oidc/handoff?id=1#x', 'https://host/orgs/acme').href).toBe(
      'https://host/orgs/acme/oidc/handoff?id=1#x',
    );
  });

  it('allows callers to extend the result with searchParams', () => {
    const url = buildRemoteUrl('/oidc/handoff', 'https://host/orgs/acme');
    url.searchParams.set('id', 'a b');
    expect(url.toString()).toBe('https://host/orgs/acme/oidc/handoff?id=a+b');
  });

  it('does not add the prefix twice when the path already carries it', () => {
    expect(buildRemoteUrl('/orgs/acme/trpc/x?a=1', 'https://host/orgs/acme').toString()).toBe(
      'https://host/orgs/acme/trpc/x?a=1',
    );
    expect(buildRemoteUrl('/orgs/acme', 'https://host/orgs/acme/').toString()).toBe(
      'https://host/orgs/acme',
    );
  });

  it('only treats whole path segments as the prefix', () => {
    expect(buildRemoteUrl('/orgs/acme-other/x', 'https://host/orgs/acme').toString()).toBe(
      'https://host/orgs/acme/orgs/acme-other/x',
    );
  });

  it('does not strip a foreign tenant prefix', () => {
    expect(buildRemoteUrl('/orgs/other/x', 'https://host/orgs/acme').toString()).toBe(
      'https://host/orgs/acme/orgs/other/x',
    );
  });

  it('returns the base itself for an empty path', () => {
    expect(buildRemoteUrl('', 'https://host/orgs/acme/').toString()).toBe('https://host/orgs/acme');
    expect(buildRemoteUrl('/', 'https://host/orgs/acme').toString()).toBe(
      'https://host/orgs/acme/',
    );
    expect(buildRemoteUrl('', 'https://custom.host').toString()).toBe('https://custom.host/');
    expect(buildRemoteUrl('?a=1', 'https://host/orgs/acme').toString()).toBe(
      'https://host/orgs/acme?a=1',
    );
  });

  it.each(['//evil.com/x', '/\\evil.com/x', '\\\\evil.com/x', '///evil.com'])(
    'rejects protocol-relative or backslash path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/orgs/acme')).toThrow();
    },
  );

  it.each(['https://evil.com/x', 'http://evil.com', 'javascript:alert(1)', 'oidc/token'])(
    'rejects an absolute URL or a non-rooted path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/orgs/acme')).toThrow();
    },
  );

  it.each(['/../orgs/other/trpc', '/a/../../orgs/other', '/%2e%2e/orgs/other', '/.%2E/orgs/other'])(
    'rejects dot segments that would leave the base path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/orgs/acme')).toThrow();
    },
  );

  it('rejects a base that is not http(s)', () => {
    expect(() => buildRemoteUrl('/x', 'ftp://host/orgs/acme')).toThrow();
    expect(() => buildRemoteUrl('/x', 'not a url')).toThrow();
  });
});

describe('isUnderRemoteBase', () => {
  it('matches the base path on whole segments', () => {
    expect(isUnderRemoteBase('/orgs/acme', 'https://host/orgs/acme/')).toBe(true);
    expect(isUnderRemoteBase('/orgs/acme/trpc', 'https://host/orgs/acme')).toBe(true);
    expect(isUnderRemoteBase('/orgs/acme-other', 'https://host/orgs/acme')).toBe(false);
    expect(isUnderRemoteBase('/trpc', 'https://host/orgs/acme')).toBe(false);
  });

  it('treats every path as under a root base', () => {
    expect(isUnderRemoteBase('/trpc', 'https://custom.host')).toBe(true);
  });
});

describe('normalizeRemoteBaseUrl', () => {
  it.each([
    ['https://host/orgs/acme', 'https://host/orgs/acme'],
    ['  https://host/orgs/acme/  ', 'https://host/orgs/acme'],
    ['https://host/orgs//acme//', 'https://host/orgs/acme'],
    ['https://host/orgs/acme?x=1#y', 'https://host/orgs/acme'],
    ['https://host/', 'https://host'],
    ['https://host', 'https://host'],
    ['HTTPS://Host:8443/orgs/acme/', 'https://host:8443/orgs/acme'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeRemoteBaseUrl(input)).toBe(expected);
  });

  it('passes through empty and invalid values for the existing validators to reject', () => {
    expect(normalizeRemoteBaseUrl(undefined)).toBeUndefined();
    expect(normalizeRemoteBaseUrl('')).toBe('');
    expect(normalizeRemoteBaseUrl('  ')).toBe('');
    expect(normalizeRemoteBaseUrl('not a url')).toBe('not a url');
    expect(normalizeRemoteBaseUrl('ftp://host/x/')).toBe('ftp://host/x/');
  });
});

describe('resolveRemoteUrl', () => {
  const TENANT = 'https://host/orgs/acme';

  it('mounts a server-relative path under the tenant base', () => {
    expect(resolveRemoteUrl('/webapi/user/avatar/u1/a.png', TENANT)).toBe(
      'https://host/orgs/acme/webapi/user/avatar/u1/a.png',
    );
    expect(resolveRemoteUrl('/f/file_1?download=1#x', `${TENANT}/`)).toBe(
      'https://host/orgs/acme/f/file_1?download=1#x',
    );
  });

  it('resolves against the origin for a root base', () => {
    expect(resolveRemoteUrl('/webapi/user/avatar/u1/a.png', 'https://custom.host')).toBe(
      'https://custom.host/webapi/user/avatar/u1/a.png',
    );
    expect(resolveRemoteUrl('/f/file_1', 'https://custom.host/')).toBe(
      'https://custom.host/f/file_1',
    );
  });

  it('does not add the tenant prefix twice to a path the server already prefixed', () => {
    expect(resolveRemoteUrl('/orgs/acme/f/file_1', TENANT)).toBe('https://host/orgs/acme/f/file_1');
  });

  it.each([
    'https://cdn.example.com/a.png',
    'http://host/orgs/acme/f/file_1',
    'data:image/png;base64,AAAA',
    'blob:app://renderer/1234',
    '//cdn.example.com/a.png',
    'relative/a.png',
    '',
  ])('returns %s as is (absolute, inline, protocol-relative and relative values)', (value) => {
    expect(resolveRemoteUrl(value, TENANT)).toBe(value);
  });

  it('returns the value as is when no usable base is known', () => {
    expect(resolveRemoteUrl('/f/file_1', '')).toBe('/f/file_1');
    expect(resolveRemoteUrl('/f/file_1', undefined)).toBe('/f/file_1');
    expect(resolveRemoteUrl('/f/file_1', 'not a url')).toBe('/f/file_1');
    expect(resolveRemoteUrl('/f/file_1', 'ftp://host/orgs/acme')).toBe('/f/file_1');
  });

  it('never throws nor leaves the tenant for a path escaping the base', () => {
    expect(resolveRemoteUrl('/../orgs/other/f/x', TENANT)).toBe('/../orgs/other/f/x');
  });
});

describe('relativeToRemoteBase', () => {
  const TENANT = 'https://host/orgs/acme';

  it('returns the app path below the base', () => {
    expect(relativeToRemoteBase('/orgs/acme/f/file_1', TENANT)).toBe('/f/file_1');
    expect(relativeToRemoteBase('/orgs/acme', `${TENANT}/`)).toBe('/');
  });

  it('returns null for another tenant, a sibling slug and an unprefixed path', () => {
    expect(relativeToRemoteBase('/orgs/other/f/file_1', TENANT)).toBeNull();
    expect(relativeToRemoteBase('/orgs/acme-x/f/file_1', TENANT)).toBeNull();
    expect(relativeToRemoteBase('/f/file_1', TENANT)).toBeNull();
  });

  it('returns the path itself for a root base', () => {
    expect(relativeToRemoteBase('/f/file_1', 'https://custom.host')).toBe('/f/file_1');
  });
});
