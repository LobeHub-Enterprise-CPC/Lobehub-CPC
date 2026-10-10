import { renderTenantRequiredPage } from '@/libs/tenant/tenantRequiredPage';

/** Static page for page requests without a tenant address (spec A16, FR-RT-06). */
export const GET = (request: Request) =>
  new Response(renderTenantRequiredPage(request.headers.get('accept-language')), {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': 'text/html; charset=utf-8',
      'Vary': 'Accept-Language',
    },
    status: 200,
  });
