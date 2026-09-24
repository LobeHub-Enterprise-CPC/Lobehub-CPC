import {
  ProviderCombine as VendorProviderCombine,
  ProviderIcon as VendorProviderIcon,
} from '@lobehub/icons';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProductLogo } from '@/components/Branding/ProductLogo';

import { ProviderCombine, ProviderIcon } from './providerIcon';

const branding = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/const/version', () => ({
  get isCustomBranding() {
    return branding.enabled;
  },
}));
vi.mock('@lobechat/business-const', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  BRANDING_LOGO_URL: '/branding/private-logo.png',
  BRANDING_NAME: 'Private Workspace',
  BRANDING_PROVIDER: 'lobehub',
}));

beforeEach(() => {
  branding.enabled = true;
});

describe('provider artwork', () => {
  it.each(['avatar', 'mono', 'color', 'combine', 'combine-color'] as const)(
    'uses the branded artwork for the %s variant',
    (type) => {
      const html = renderToStaticMarkup(
        createElement(ProviderIcon, {
          className: 'provider-mark',
          provider: 'lobehub',
          size: 18,
          style: { opacity: 0.6 },
          type,
        }),
      );

      expect(html).toContain('src="/branding/private-logo.png"');
      expect(html).toContain('width="18"');
      expect(html).not.toContain('<svg');
      expect(html).toMatch(/class="[^"]*\bprovider-mark\b/);
      expect(html).toContain('opacity:0.6');
      if (type === 'mono') expect(html).toContain('grayscale(100%)');
      if (type.startsWith('combine')) expect(html).toContain('>Private Workspace<');
    },
  );

  it('preserves the combined wordmark root class and layout styles', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderCombine, {
        className: 'provider-wordmark',
        provider: 'lobehub',
        size: 24,
        style: { marginInlineStart: 7, opacity: 0.6 },
      }),
    );
    const container = document.createElement('div');
    container.innerHTML = html;
    const wordmark = container.querySelector<HTMLElement>('.provider-wordmark');

    expect(wordmark).toBe(container.querySelector('img')?.parentElement);
    expect(wordmark?.style.marginInlineStart).toBe('7px');
    expect(wordmark?.style.opacity).toBe('0.6');
    expect(wordmark).toHaveTextContent('Private Workspace');
  });

  it.each(['flat', 'combine'] as const)(
    'keeps the extra-logo class on its outer root (%s)',
    (type) => {
      const container = document.createElement('div');
      container.innerHTML = renderToStaticMarkup(
        createElement(ProductLogo, { className: 'extra-logo', extra: 'Workspace', size: 18, type }),
      );

      expect(container.querySelectorAll('.extra-logo')).toHaveLength(1);
      expect(container.querySelector('.extra-logo')).toBe(
        container.querySelector('img')?.parentElement,
      );
      expect(container.querySelector('.extra-logo')).toHaveTextContent('Workspace');
      expect(container.querySelector('img')).not.toHaveClass('extra-logo');
    },
  );

  it.each(['anthropic', 'deepseek', 'not-a-provider', undefined])(
    'preserves vendor behavior for %s, including unknown/missing providers',
    (provider) => {
      const props = { provider, size: 19 };
      expect(renderToStaticMarkup(createElement(ProviderIcon, props))).toBe(
        renderToStaticMarkup(createElement(VendorProviderIcon, props)),
      );
      expect(renderToStaticMarkup(createElement(ProviderCombine, props))).toBe(
        renderToStaticMarkup(createElement(VendorProviderCombine, props)),
      );
    },
  );

  it('keeps the upstream provider artwork on an unbranded build', () => {
    branding.enabled = false;
    const props = { provider: 'lobehub', size: 23 };
    expect(renderToStaticMarkup(createElement(ProviderIcon, props))).toBe(
      renderToStaticMarkup(createElement(VendorProviderIcon, props)),
    );
    expect(renderToStaticMarkup(createElement(ProviderCombine, props))).toBe(
      renderToStaticMarkup(createElement(VendorProviderCombine, props)),
    );
  });

  it.each(['unsloth', 'Unsloth'])('renders the official %s avatar and wordmark', (provider) => {
    const avatar = renderToStaticMarkup(createElement(ProviderIcon, { provider, type: 'avatar' }));
    const wordmark = renderToStaticMarkup(createElement(ProviderCombine, { provider }));

    expect(avatar).toContain('<title>Unsloth</title>');
    expect(avatar).not.toContain('lucide-provider');
    expect(wordmark).toContain('<title>Unsloth</title>');
    expect(wordmark).not.toContain('lucide-provider');
    expect((wordmark.match(/<svg /g) || []).length).toBe(2);
  });
});
