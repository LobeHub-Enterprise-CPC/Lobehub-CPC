import { APIError } from 'better-auth/api';
import { toNextJsHandler } from 'better-auth/next-js';
import type { NextRequest } from 'next/server';

import { getAuthForRequest } from '@/auth';
import { redirectCallbackError } from '@/libs/better-auth/callback-error-response';

const jsonContentTypeRegex = /^application\/(?:[a-z0-9.+-]*\+)?json/i;

const dispatch = async (request: Request, method: 'GET' | 'POST') => {
  try {
    const handler = toNextJsHandler(await getAuthForRequest(request));
    return await redirectCallbackError(request, await handler[method](request));
  } catch (error) {
    const status = error instanceof APIError ? error.statusCode : 503;
    const code = error instanceof APIError ? error.body?.code : 'SSO_UNAVAILABLE';
    return redirectCallbackError(
      request,
      Response.json({ code, message: code }, { status, headers: { 'Cache-Control': 'no-store' } }),
    );
  }
};

const malformedJsonResponse = () =>
  Response.json({ code: 'INVALID_JSON', message: 'Malformed JSON request body' }, { status: 400 });

/**
 * better-call currently treats Request.json() SyntaxError as a server error.
 * Validate JSON bodies at the route boundary so malformed client payloads stay 400s.
 */
const validateJsonBody = async (request: Request) => {
  const contentType = request.headers.get('content-type') || '';
  if (!request.body || !jsonContentTypeRegex.test(contentType)) return;

  try {
    await request.clone().json();
  } catch (error) {
    if (error instanceof SyntaxError) return malformedJsonResponse();
    throw error;
  }
};

export const GET = (request: Request) => dispatch(request, 'GET');

export const POST = async (request: NextRequest) => {
  const invalidJsonResponse = await validateJsonBody(request);
  if (invalidJsonResponse) return invalidJsonResponse;

  return dispatch(request, 'POST');
};
