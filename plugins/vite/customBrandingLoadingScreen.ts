// Deep import on purpose: the package root barrel uses extensionless relative
// imports that Node's type-stripping loader (which evaluates externalized
// config-time imports) cannot resolve. branding.ts is a dependency-free leaf
// exposed via the './branding' subpath — keep it import-free.
import {
  BRANDING_NAME,
  BRANDING_WORDMARK_DARK_URL,
  BRANDING_WORDMARK_URL,
} from '@lobechat/business-const/branding';
import type { Plugin } from 'vite';

const LOADING_BRAND_BLOCK = /<div id="loading-brand"[^>]*>[\S\s]*?<\/div>/;

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/**
 * Replace the hardcoded LobeHub wordmark in the static loading screen with the
 * custom wordmark (or name), so white-label deployments (BRANDING_NAME !== 'LobeHub')
 * never flash the LobeHub logo before the SPA boots. No-op for the default
 * branding.
 */
export const customBrandingLoadingScreen = (): Plugin => ({
  name: 'custom-branding-loading-screen',
  transformIndexHtml: {
    handler(html) {
      // @ts-ignore -- see the note on isCustomBranding in @lobechat/const's
      // version.ts: a custom BRANDING_NAME narrows this to a non-overlapping
      // literal type, but the runtime comparison is exactly what we want.
      if (BRANDING_NAME === 'LobeHub') return html;

      if (BRANDING_WORDMARK_URL) {
        const light = escapeHtml(BRANDING_WORDMARK_URL);
        const dark = escapeHtml(BRANDING_WORDMARK_DARK_URL || BRANDING_WORDMARK_URL);
        return html.replace(
          LOADING_BRAND_BLOCK,
          `<div id="loading-brand" aria-label="Loading" role="status">
            <style>
              #loading-brand { opacity: 1; }
              #loading-brand img { height: 40px; width: auto; max-width: 80vw; filter: none; }
              #loading-brand .brand-dark { display: none; }
              html[data-theme='dark'] #loading-brand .brand-light { display: none; }
              html[data-theme='dark'] #loading-brand .brand-dark { display: block; }
            </style>
            <img class="brand-light" alt="${escapeHtml(BRANDING_NAME)}" height="40" src="${light}" />
            <img class="brand-dark" alt="${escapeHtml(BRANDING_NAME)}" height="40" src="${dark}" />
          </div>`,
        );
      }

      return html.replace(
        LOADING_BRAND_BLOCK,
        `<div id="loading-brand" aria-label="Loading" role="status" style="font-size: 26px; font-weight: 700; letter-spacing: 0.02em;">${escapeHtml(
          BRANDING_NAME,
        )}</div>`,
      );
    },
    // Branding URLs belong to the application origin, not the SPA asset base.
    // Insert after Vite rewrites HTML URLs: copySpaBuild does not publish
    // public/branding under /_spa (or on the configured asset CDN).
    order: 'post',
  },
});
