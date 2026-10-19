import { escapeText } from 'entities';
import { type NextRequest, NextResponse } from 'next/server';

import { LOBE_LOCALE_COOKIE } from '@/const/locale';
import { translation } from '@/libs/i18n/serverTranslation';
import { DESKTOP_FLOW_HEADER } from '@/server/services/tenantDiscovery/navigation';
import type { DesktopFlowStatus } from '@/types/spaServerConfig';
import { parseBrowserLanguage } from '@/utils/locale';

import type { TenantMiddlewareDeps } from './types';

export const rejectJson = (code: string, status: number) =>
  Response.json(
    { code },
    {
      headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' },
      status,
    },
  );

export const rewriteTo = (request: NextRequest, pathname: string, headers?: Headers) => {
  const url = new URL(request.url);
  url.pathname = pathname;
  return NextResponse.rewrite(url, headers ? { request: { headers } } : undefined);
};

const requestLocale = (deps: TenantMiddlewareDeps, request: NextRequest) =>
  deps.toSafeLocale(
    request.nextUrl.searchParams.get('hl') ||
      request.cookies.get(LOBE_LOCALE_COOKIE)?.value ||
      parseBrowserLanguage(request.headers),
  );

/** `retryUrl` must be a trusted, context-free URL; the default retries the platform root. */
export const navigationUnavailable = async (
  deps: TenantMiddlewareDeps,
  request: NextRequest,
  retryUrl = '/#',
) => {
  const locale = requestLocale(deps, request);
  const [{ t }, { t: common }] = await Promise.all([
    translation('auth', locale),
    translation('common', locale),
  ]);
  return new Response(
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>503</title></head><body><main><p>${escapeText(t('organization.discovery.unavailable'))}</p><a href="${escapeText(retryUrl)}">${escapeText(common('retry'))}</a></main></body></html>`,
    {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Retry-After': '5',
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
};

export const discoveryPage = (
  deps: TenantMiddlewareDeps,
  request: NextRequest,
  headers: Headers,
  desktopStatus?: DesktopFlowStatus,
) => {
  const url = new URL(request.url);
  url.pathname = `/spa-auth/${requestLocale(deps, request)}/`;
  // The root shell must not receive arbitrary authentication/protocol query context.
  url.search = '';
  const routedHeaders = new Headers(headers);
  routedHeaders.delete(DESKTOP_FLOW_HEADER);
  if (desktopStatus) routedHeaders.set(DESKTOP_FLOW_HEADER, desktopStatus);
  return NextResponse.rewrite(url, { request: { headers: routedHeaders } });
};
