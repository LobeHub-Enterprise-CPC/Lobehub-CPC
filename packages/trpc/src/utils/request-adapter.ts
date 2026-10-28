import { stripTenantPath } from '@lobechat/business-tenant/routing';
import { type NextRequest } from 'next/server';

/**
 * Prepare Request object for tRPC fetchRequestHandler
 *
 * This function solves the "Response body object should not be disturbed or locked" error
 * that occurs in Next.js 16 when the request body stream has been consumed or locked
 * by Next.js internal mechanisms.
 *
 * By cloning the Request object, we create an independent body stream that tRPC can safely read.
 *
 * @see https://github.com/vercel/next.js/issues/83453
 * @param req - The original NextRequest object
 * @returns A cloned Request object with an independent body stream
 */
export function prepareRequestForTRPC(req: NextRequest): Request {
  // Clone the Request to create an independent body stream
  // This ensures tRPC can read the body even if the original request's body was disturbed
  const url = new URL(req.url);
  // Next route rewrites can retain the original tenant URL. tRPC extracts
  // the procedure relative to its unprefixed endpoint, after tenant admission.
  url.pathname = stripTenantPath(url.pathname);
  return new Request(url, req.clone());
}
