/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import { navigationRedirect } from './navigationRedirect';

describe('fragment-clearing navigation redirect', () => {
  it.each([
    'http://localhost:3010/?switch=1#',
    'https://chat.example.com/t/acme/#',
    'https://chat.example.com/oidc/auth?state=authorized&a=b#',
  ])(
    'answers a page that refreshes to the target and keeps its empty fragment: %s',
    async (location) => {
      const response = navigationRedirect(location);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      const html = await response.text();
      expect(html).toContain(`content="0;url=${location.replaceAll('&', '&amp;')}"`);
      expect(html).not.toContain('<script');
    },
  );

  it('only accepts absolute http(s) targets that end in an empty fragment', () => {
    for (const location of [
      'http://localhost:3010/',
      'http://localhost:3010/#x',
      '/relative#',
      'javascript:alert(1)//#',
      'https://user:pass@chat.example.com/#',
      'https://chat.example.com/a b#',
      'http://localhost:3010/"><script>alert(1)</script>#',
    ]) {
      const response = navigationRedirect(location);
      expect(response.status).toBe(503);
      expect(response.headers.get('location')).toBeNull();
    }
  });
});
