import { handleNavigationRedirect } from '@/libs/next/proxy/navigationRedirect';

export const dynamic = 'force-dynamic';

/** A signed, same-host browser navigation; it grants no tenant or account identity. */
export const GET = (request: Request) => handleNavigationRedirect(request);

export const HEAD = () => new Response(null, { status: 404 });
