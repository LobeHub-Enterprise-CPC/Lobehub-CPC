import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.doMock('@lobechat/business-const/branding', () => ({ BRANDING_NAME: 'AI Workstation' }));
    const handler = await loadHandler();

    const result = handler(SAMPLE_HTML);
    // Text-only, deliberately: this HTML paints before any JS bundle runs, so a
    // brand image has no build-time guarantee of existing at that path yet
    // (and no runtime fallback if it 404s) — see the file's own doc comment.
    // A regression back to an <img> tag must fail loudly here, not just look
    // fine because no <svg> remains.
    expect(result).not.toContain('<svg');
    expect(result).not.toContain('<img');
    expect(result).not.toContain('LobeHub');
    expect(result).toContain('AI Workstation');
    expect(result).toContain('id="loading-brand"');
    // the rest of the document is preserved
    expect(result).toContain('<div id="root" style="height: 100%"></div>');
  });

  it('is idempotent when processing an already branded boot screen', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({ BRANDING_NAME: 'AI Workstation' }));
    const handler = await loadHandler();
    const once = handler(SAMPLE_HTML);

    expect(handler(once)).toBe(once);
  });

  it('escapes HTML-sensitive characters in the brand name', async () => {
    vi.doMock('@lobechat/business-const/branding', () => ({ BRANDING_NAME: 'A<B>&"C' }));
    const handler = await loadHandler();

    const result = handler(SAMPLE_HTML);
    expect(result).toContain('A&lt;B&gt;&amp;&quot;C');
    expect(result).not.toContain('A<B>');
  });
});
