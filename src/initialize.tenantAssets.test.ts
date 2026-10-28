import { beforeAll, describe, expect, it } from 'vitest';

describe('initialize on a tenant page', () => {
  beforeAll(async () => {
    (globalThis as any).__REACT_SCAN__ = false;
    window.history.replaceState(null, '', '/t/acme/settings/profile');
    await import('./initialize');
  });

  it('loads a stored avatar path of the tenant, not of the bare origin', () => {
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');

    expect(img.getAttribute('src')).toBe('/t/acme/webapi/user/avatar/user_1/a.webp');
  });
});
