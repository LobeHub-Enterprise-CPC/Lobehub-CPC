import { handleNavigationRedirect } from '@/libs/next/proxy/navigationRedirect';

export const dynamic = 'force-dynamic';

/** Reached only through the proxy's internal rewrite; see `navigationRedirect.ts`. */
export const GET = handleNavigationRedirect;
