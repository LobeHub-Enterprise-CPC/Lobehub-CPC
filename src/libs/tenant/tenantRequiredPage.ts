import { BRANDING_NAME } from '@lobechat/business-const';

import enUS from '../../../locales/en-US/tenant.json';
import zhCN from '../../../locales/zh-CN/tenant.json';

/**
 * Static page for a page request without a tenant address (spec A16,
 * FR-RT-06). It lists no tenant, calls no API, offers no sign-in, and is the
 * same for every visitor whatever their cookies: only the language follows
 * `Accept-Language`. An unknown `/t/{slug}` gets this same page, so it never
 * reveals which tenants exist.
 */

type Messages = typeof enUS;

const pickMessages = (acceptLanguage: string | null): { lang: string; messages: Messages } =>
  /^\s*zh\b/i.test(acceptLanguage ?? '')
    ? { lang: 'zh-CN', messages: zhCN }
    : { lang: 'en-US', messages: enUS };

const escapeHtml = (value: string) =>
  value.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const interpolate = (template: string, values: Record<string, string>) =>
  template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '');

export const renderTenantRequiredPage = (acceptLanguage: string | null) => {
  const { lang, messages } = pickMessages(acceptLanguage);
  const values = { appName: BRANDING_NAME, example: '…/t/…' };
  const title = escapeHtml(messages['required.title']);
  const desc = escapeHtml(interpolate(messages['required.desc'], values));
  const hint = escapeHtml(messages['required.hint']);
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f1f1f;--muted:#6b6b6b}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#f0f0f0;--muted:#a3a3a3}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:480px;padding:24px 16px;text-align:center}
h1{font-size:22px;font-weight:600;margin:0 0 12px}
p{margin:0 0 8px;color:var(--muted)}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${desc}</p>
<p>${hint}</p>
</main>
</body>
</html>`;
};
