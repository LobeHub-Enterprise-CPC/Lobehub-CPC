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
    ['https://host/t/acme'],
    ['https://host/t/acme/'],
    ['https://host/t/acme//'],
    ['https://host/t/acme?x=1#frag'],
    [new URL('https://host/t/acme/')],
  ])('mounts an app path under the tenant base %s', (base) => {
    expect(buildRemoteUrl('/oidc/token', base).toString()).toBe('https://host/t/acme/oidc/token');
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
    expect(buildRemoteUrl('/trpc', 'http://127.0.0.1:3210/t/acme').toString()).toBe(
      'http://127.0.0.1:3210/t/acme/trpc',
    );
  });

  it('keeps query and hash of the path', () => {
    expect(
      buildRemoteUrl('/trpc/lambda/a.b?batch=1&input=%7B%7D', 'https://host/t/acme').href,
    ).toBe('https://host/t/acme/trpc/lambda/a.b?batch=1&input=%7B%7D');
    expect(buildRemoteUrl('/oidc/handoff?id=1#x', 'https://host/t/acme').href).toBe(
      'https://host/t/acme/oidc/handoff?id=1#x',
    );
  });

  it('allows callers to extend the result with searchParams', () => {
    const url = buildRemoteUrl('/oidc/handoff', 'https://host/t/acme');
    url.searchParams.set('id', 'a b');
    expect(url.toString()).toBe('https://host/t/acme/oidc/handoff?id=a+b');
  });

  it('does not add the prefix twice when the path already carries it', () => {
    expect(buildRemoteUrl('/t/acme/trpc/x?a=1', 'https://host/t/acme').toString()).toBe(
      'https://host/t/acme/trpc/x?a=1',
    );
    expect(buildRemoteUrl('/t/acme', 'https://host/t/acme/').toString()).toBe(
      'https://host/t/acme',
    );
  });

  it('only treats whole path segments as the prefix', () => {
    expect(buildRemoteUrl('/t/acme-other/x', 'https://host/t/acme').toString()).toBe(
      'https://host/t/acme/t/acme-other/x',
    );
  });

  it('does not strip a foreign tenant prefix', () => {
    expect(buildRemoteUrl('/t/other/x', 'https://host/t/acme').toString()).toBe(
      'https://host/t/acme/t/other/x',
    );
  });

  it('returns the base itself for an empty path', () => {
    expect(buildRemoteUrl('', 'https://host/t/acme/').toString()).toBe('https://host/t/acme');
    expect(buildRemoteUrl('/', 'https://host/t/acme').toString()).toBe('https://host/t/acme/');
    expect(buildRemoteUrl('', 'https://custom.host').toString()).toBe('https://custom.host/');
    expect(buildRemoteUrl('?a=1', 'https://host/t/acme').toString()).toBe(
      'https://host/t/acme?a=1',
    );
  });

  it.each(['//evil.com/x', '/\\evil.com/x', '\\\\evil.com/x', '///evil.com'])(
    'rejects protocol-relative or backslash path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/t/acme')).toThrow();
    },
  );

  it.each(['https://evil.com/x', 'http://evil.com', 'javascript:alert(1)', 'oidc/token'])(
    'rejects an absolute URL or a non-rooted path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/t/acme')).toThrow();
    },
  );

  it.each(['/../t/other/trpc', '/a/../../t/other', '/%2e%2e/t/other', '/.%2E/t/other'])(
    'rejects dot segments that would leave the base path %s',
    (path) => {
      expect(() => buildRemoteUrl(path, 'https://host/t/acme')).toThrow();
    },
  );

  it('rejects a base that is not http(s)', () => {
    expect(() => buildRemoteUrl('/x', 'ftp://host/t/acme')).toThrow();
    expect(() => buildRemoteUrl('/x', 'not a url')).toThrow();
  });
});

describe('isUnderRemoteBase', () => {
  it('matches the base path on whole segments', () => {
    expect(isUnderRemoteBase('/t/acme', 'https://host/t/acme/')).toBe(true);
    expect(isUnderRemoteBase('/t/acme/trpc', 'https://host/t/acme')).toBe(true);
    expect(isUnderRemoteBase('/t/acme-other', 'https://host/t/acme')).toBe(false);
    expect(isUnderRemoteBase('/trpc', 'https://host/t/acme')).toBe(false);
  });

  it('treats every path as under a root base', () => {
    expect(isUnderRemoteBase('/trpc', 'https://custom.host')).toBe(true);
  });
});

describe('normalizeRemoteBaseUrl', () => {
  it.each([
    ['https://host/t/acme', 'https://host/t/acme'],
    ['  https://host/t/acme/  ', 'https://host/t/acme'],
    ['https://host/t//acme//', 'https://host/t/acme'],
    ['https://host/t/acme?x=1#y', 'https://host/t/acme'],
    ['https://host/', 'https://host'],
    ['https://host', 'https://host'],
    ['HTTPS://Host:8443/t/acme/', 'https://host:8443/t/acme'],
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
  const TENANT = 'https://host/t/acme';

  it('mounts a server-relative path under the tenant base', () => {
    expect(resolveRemoteUrl('/webapi/user/avatar/u1/a.png', TENANT)).toBe(
      'https://host/t/acme/webapi/user/avatar/u1/a.png',
    );
    expect(resolveRemoteUrl('/f/file_1?download=1#x', `${TENANT}/`)).toBe(
      'https://host/t/acme/f/file_1?download=1#x',
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
    expect(resolveRemoteUrl('/t/acme/f/file_1', TENANT)).toBe('https://host/t/acme/f/file_1');
  });

  it.each([
    'https://cdn.example.com/a.png',
    'http://host/t/acme/f/file_1',
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
    expect(resolveRemoteUrl('/f/file_1', 'ftp://host/t/acme')).toBe('/f/file_1');
  });

  it('never throws nor leaves the tenant for a path escaping the base', () => {
    expect(resolveRemoteUrl('/../t/other/f/x', TENANT)).toBe('/../t/other/f/x');
  });
});

describe('relativeToRemoteBase', () => {
  const TENANT = 'https://host/t/acme';

  it('returns the app path below the base', () => {
    expect(relativeToRemoteBase('/t/acme/f/file_1', TENANT)).toBe('/f/file_1');
    expect(relativeToRemoteBase('/t/acme', `${TENANT}/`)).toBe('/');
  });

  it('returns null for another tenant, a sibling slug and an unprefixed path', () => {
    expect(relativeToRemoteBase('/t/other/f/file_1', TENANT)).toBeNull();
    expect(relativeToRemoteBase('/t/acme-x/f/file_1', TENANT)).toBeNull();
    expect(relativeToRemoteBase('/f/file_1', TENANT)).toBeNull();
  });

  it('returns the path itself for a root base', () => {
    expect(relativeToRemoteBase('/f/file_1', 'https://custom.host')).toBe('/f/file_1');
  });
});
