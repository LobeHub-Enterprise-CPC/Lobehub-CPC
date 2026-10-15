import { describe, expect, it } from 'vitest';

import { classifyEntry, normalizeEntryUrl } from '../entry';

const PLATFORM = 'https://platform.example';

describe('normalizeEntryUrl', () => {
  it('canonicalizes https addresses and drops query, hash and trailing slashes', () => {
    expect(normalizeEntryUrl(' HTTPS://Platform.Example/t/acme/?x=1#y ')).toBe(
      'https://platform.example/t/acme',
    );
  });

  it('rejects plain http, credentials and non-http schemes', () => {
    expect(normalizeEntryUrl('http://platform.example/t/acme')).toBeNull();
    expect(normalizeEntryUrl('https://user:pw@platform.example')).toBeNull();
    expect(normalizeEntryUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeEntryUrl('not a url')).toBeNull();
  });

  it('allows http only for loopback hosts and only when development asks for it', () => {
    expect(normalizeEntryUrl('http://localhost:3010/t/acme')).toBeNull();
    expect(normalizeEntryUrl('http://localhost:3010/t/acme', true)).toBe(
      'http://localhost:3010/t/acme',
    );
    expect(normalizeEntryUrl('http://127.0.0.1:3010', true)).toBe('http://127.0.0.1:3010');
    expect(normalizeEntryUrl('http://192.168.1.2:3010', true)).toBeNull();
  });
});

describe('classifyEntry', () => {
  it.each([
    [PLATFORM, 'platform'],
    [`${PLATFORM}/t/acme`, 'tenant'],
    [`${PLATFORM}/t/acme/extra`, 'invalid'],
    [`${PLATFORM}/t/A`, 'invalid'],
    [`${PLATFORM}/agent`, 'invalid'],
    ['https://chat.customer.example', 'tenant'],
    ['https://self-host.example/sub', 'tenant'],
  ])('%s is %s', (url, kind) => {
    expect(classifyEntry(url, PLATFORM).kind).toBe(kind);
  });

  it('reports the slug of a /t/{slug} entry', () => {
    expect(classifyEntry(`${PLATFORM}/t/acme-co`, PLATFORM)).toEqual({
      kind: 'tenant',
      slug: 'acme-co',
    });
  });
});
