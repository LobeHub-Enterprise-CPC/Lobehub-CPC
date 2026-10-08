// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { copySpaBuild } from '../../scripts/copySpaBuildCore';

const SAMPLE_HTML = `<body>
    <div id="loading-screen">
      <div id="loading-brand" aria-label="Loading" role="status">
        <svg fill="currentColor" height="40" viewBox="0 0 940 320" xmlns="http://www.w3.org/2000/svg">
          <title>LobeHub</title>
          <path d="M15 240.035V87.172h39.24V205.75h66.192v34.285H15z" />
        </svg>
      </div>
    </div>
    <div id="root" style="height: 100%"></div>
  </body>`;

const loadHandler = async () => {
  const { customBrandingLoadingScreen } = await import('./customBrandingLoadingScreen');
  const plugin = customBrandingLoadingScreen();
  return (plugin.transformIndexHtml as { handler: (html: string) => string }).handler;
};

describe('customBrandingLoadingScreen', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps the default LobeHub wordmark untouched', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({ BRANDING_NAME: 'LobeHub' }));
    const handler = await loadHandler();

    expect(handler(SAMPLE_HTML)).toBe(SAMPLE_HTML);
  });

  it('replaces the wordmark with the custom brand name', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({
      BRANDING_NAME: 'AI Workstation',
      BRANDING_WORDMARK_URL: '',
    }));
    const handler = await loadHandler();

    const result = handler(SAMPLE_HTML);
    // Distributions without a wordmark keep the text-only fallback.
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('LobeHub');
    expect(result).toContain('AI Workstation');
    expect(result).toContain('id="loading-brand"');
    // the rest of the document is preserved
    expect(result).toContain('<div id="root" style="height: 100%"></div>');
  });

  it('is idempotent when processing an already branded boot screen', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({
      BRANDING_NAME: 'AI Workstation',
      BRANDING_WORDMARK_URL: '',
    }));
    const handler = await loadHandler();
    const once = handler(SAMPLE_HTML);

    expect(handler(once)).toBe(once);
  });

  it('escapes HTML-sensitive characters in the brand name', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({
      BRANDING_NAME: 'A<B>&"C',
      BRANDING_WORDMARK_URL: '',
    }));
    const handler = await loadHandler();

    const result = handler(SAMPLE_HTML);
    expect(result).toContain('A&lt;B&gt;&amp;&quot;C');
    expect(result).not.toContain('A<B>');
  });

  it('renders both themed wordmarks without changing the remaining shell', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({
      BRANDING_NAME: 'Acme Workspace',
      BRANDING_WORDMARK_URL: '/branding/light.svg?a=1&b=2',
      BRANDING_WORDMARK_DARK_URL: '/branding/dark.svg',
    }));
    const handler = await loadHandler();
    const result = handler(SAMPLE_HTML);
    expect(result).toContain('src="/branding/light.svg?a=1&amp;b=2"');
    expect(result).toContain('src="/branding/dark.svg"');
    expect(result).toContain("html[data-theme='dark'] #loading-brand .brand-dark");
    expect(result).toContain('<div id="root" style="height: 100%"></div>');
    expect(handler(result)).toBe(result);
  });

  it.each(['/_spa/', '/_spa-workbench/', 'https://assets.example.com/build/', '/'])(
    'keeps wordmarks reachable after a production build with base %s',
    async (base) => {
      vi.doMock('@lobechat/business-const/branding', () => ({
        BRANDING_NAME: 'Acme Workspace',
        BRANDING_WORDMARK_DARK_URL: '/branding/dark.svg',
        BRANDING_WORDMARK_URL: '/branding/light.svg',
      }));
      const { customBrandingLoadingScreen } = await import('./customBrandingLoadingScreen');
      const root = mkdtempSync(path.join(tmpdir(), 'branding-build-'));
      const wordmarks = ['/branding/light.svg', '/branding/dark.svg'];

      try {
        mkdirSync(path.join(root, 'public/branding'), { recursive: true });
        for (const wordmark of wordmarks) {
          writeFileSync(
            path.join(root, 'public', wordmark),
            '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>',
          );
        }
        writeFileSync(path.join(root, 'index.html'), SAMPLE_HTML);

        await build({
          base,
          build: { outDir: 'dist/desktop' },
          configFile: false,
          logLevel: 'silent',
          plugins: [customBrandingLoadingScreen()],
          root,
        });
        copySpaBuild(root);

        const html = readFileSync(path.join(root, 'dist/desktop/index.html'), 'utf8');
        const imageSources = [...html.matchAll(/<img\s[^>]*src="([^"]+)"/g)].map(
          (match) => match[1],
        );
        expect(imageSources).toEqual(wordmarks);
        for (const src of imageSources) {
          expect(existsSync(path.join(root, 'public', src))).toBe(true);
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );
});
