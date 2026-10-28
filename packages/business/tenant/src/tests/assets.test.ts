import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeTenant, installTenantAssets, resolveTenantAssetUrl } from '../client';

const enterTenantPage = (pathname: string) => {
  window.history.replaceState(null, '', pathname);
  initializeTenant(new URL(window.location.href));
};

describe('installTenantAssets', () => {
  let restore: (() => void) | undefined;

  beforeEach(() => {
    enterTenantPage('/orgs/acme/settings/profile');
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
    window.history.replaceState(null, '', '/');
    initializeTenant(new URL(window.location.href));
  });

  const install = () => {
    restore = installTenantAssets(window as Window & typeof globalThis);
  };

  it('puts the tenant on a stored avatar path rendered by an <img>', () => {
    install();
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('src')).toBe('/orgs/acme/webapi/user/avatar/user_1/a.webp');
  });

  it('covers the src property as well as the attribute', () => {
    install();
    const img = document.createElement('img');
    img.src = '/webapi/user/avatar/user_1/a.webp';
    expect(img.getAttribute('src')).toBe('/orgs/acme/webapi/user/avatar/user_1/a.webp');

    const image = new Image();
    image.src = '/f/file_1';
    expect(image.getAttribute('src')).toBe('/orgs/acme/f/file_1');
  });

  it.each([
    ['source', 'src'],
    ['video', 'src'],
    ['video', 'poster'],
    ['audio', 'src'],
    ['track', 'src'],
    ['iframe', 'src'],
    ['embed', 'src'],
    ['a', 'href'],
    ['area', 'href'],
  ])('covers <%s %s>', (tag, attribute) => {
    install();
    const element = document.createElement(tag);
    element.setAttribute(attribute, '/f/file_1');
    expect(element.getAttribute(attribute)).toBe('/orgs/acme/f/file_1');
  });

  it('covers the href property of a link (download href)', () => {
    install();
    const anchor = document.createElement('a');
    anchor.href = '/f/file_1';
    expect(anchor.getAttribute('href')).toBe('/orgs/acme/f/file_1');
  });

  it.each([
    ['/images/logo.png'],
    ['/_next/static/a.js'],
    ['/orgs/acme/webapi/user/avatar/user_1/a.webp'],
    ['https://cdn.example.com/webapi/user/avatar/a.webp'],
    ['data:image/png;base64,AAAA'],
    ['blob:https://app.example.com/1234'],
    ['#section'],
    ['mailto:a@example.com'],
    [''],
  ])('leaves %s unchanged', (value) => {
    install();
    const img = document.createElement('img');
    img.setAttribute('src', value);
    expect(img.getAttribute('src')).toBe(value);
  });

  it('only touches the attributes that hold a URL', () => {
    install();
    const img = document.createElement('img');
    img.setAttribute('alt', '/webapi/user/avatar/user_1/a.webp');
    img.setAttribute('data-src', '/webapi/user/avatar/user_1/a.webp');
    const div = document.createElement('div');
    div.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');

    expect(img.getAttribute('alt')).toBe('/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('data-src')).toBe('/webapi/user/avatar/user_1/a.webp');
    expect(div.getAttribute('src')).toBe('/webapi/user/avatar/user_1/a.webp');
  });

  it('does nothing on a page without a tenant', () => {
    enterTenantPage('/agent');
    install();
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('src')).toBe('/webapi/user/avatar/user_1/a.webp');
  });

  it('does nothing on a tenant address without a path prefix (own domain)', () => {
    initializeTenant(new URL('https://chat.example.com/'), {
      basePath: '',
      slug: 'acme',
    });
    install();
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('src')).toBe('/webapi/user/avatar/user_1/a.webp');
  });

  it('restores the original behaviour', () => {
    install();
    restore!();
    restore = undefined;
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('src')).toBe('/webapi/user/avatar/user_1/a.webp');
  });

  it('does not stack when installed twice', () => {
    install();
    const second = installTenantAssets(window as Window & typeof globalThis);
    second();
    const img = document.createElement('img');
    img.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(img.getAttribute('src')).toBe('/orgs/acme/webapi/user/avatar/user_1/a.webp');

    restore!();
    restore = undefined;
    const other = document.createElement('img');
    other.setAttribute('src', '/webapi/user/avatar/user_1/a.webp');
    expect(other.getAttribute('src')).toBe('/webapi/user/avatar/user_1/a.webp');
  });
});

describe('resolveTenantAssetUrl', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
    initializeTenant(new URL(window.location.href));
  });

  it('prefixes a server-relative backend path for CSS url() and other non-DOM-attribute uses', () => {
    enterTenantPage('/orgs/acme/agent');
    expect(resolveTenantAssetUrl('/f/file_1')).toBe('/orgs/acme/f/file_1');
    expect(resolveTenantAssetUrl('/webapi/user/avatar/u/a.webp')).toBe(
      '/orgs/acme/webapi/user/avatar/u/a.webp',
    );
  });

  it.each([
    ['/app-images/banner.png'],
    ['https://cdn.example.com/a.png'],
    ['/orgs/acme/f/file_1'],
    ['data:image/png;base64,AAAA'],
  ])('keeps %s as it is', (value) => {
    enterTenantPage('/orgs/acme/agent');
    expect(resolveTenantAssetUrl(value)).toBe(value);
  });

  it('keeps the value on a page without a tenant', () => {
    enterTenantPage('/agent');
    expect(resolveTenantAssetUrl('/f/file_1')).toBe('/f/file_1');
  });
});
