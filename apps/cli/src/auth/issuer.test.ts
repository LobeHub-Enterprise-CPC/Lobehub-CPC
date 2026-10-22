import { describe, expect, it } from 'vitest';

import { sameServerUrl } from './issuer';

describe('sameServerUrl', () => {
  it.each([
    ['https://host/t/a', 'https://host/t/a/'],
    ['https://HOST/t/a', 'https://host/t/a'],
    ['https://host:443/t/a', 'https://host/t/a'],
  ])('treats %s and %s as the same server', (a, b) => {
    expect(sameServerUrl(a, b)).toBe(true);
  });

  it.each([
    ['https://host/t/a', 'https://host/t/b'],
    ['https://host/t/a', 'https://host'],
    ['https://host/t/a', 'http://host/t/a'],
    ['https://host/t/a', 'https://other/t/a'],
    ['https://host/t/a', undefined],
    ['not a url', 'not a url'],
  ])('keeps %s and %s apart', (a, b) => {
    expect(sameServerUrl(a, b)).toBe(false);
  });
});
