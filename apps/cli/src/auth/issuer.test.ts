import { describe, expect, it } from 'vitest';

import { sameServerUrl } from './issuer';

describe('sameServerUrl', () => {
  it.each([
    ['https://host/orgs/a', 'https://host/orgs/a/'],
    ['https://HOST/orgs/a', 'https://host/orgs/a'],
    ['https://host:443/orgs/a', 'https://host/orgs/a'],
  ])('treats %s and %s as the same server', (a, b) => {
    expect(sameServerUrl(a, b)).toBe(true);
  });

  it.each([
    ['https://host/orgs/a', 'https://host/orgs/b'],
    ['https://host/orgs/a', 'https://host'],
    ['https://host/orgs/a', 'http://host/orgs/a'],
    ['https://host/orgs/a', 'https://other/orgs/a'],
    ['https://host/orgs/a', undefined],
    ['not a url', 'not a url'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(sameServerUrl(a, b)).toBe(false);
  });
});
