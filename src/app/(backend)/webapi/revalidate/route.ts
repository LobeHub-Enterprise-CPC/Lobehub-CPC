import { revalidateTag } from 'next/cache';
import { type NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { withTenantRequest } from '@/server/modules/Tenant/gate';

const handleGet = async (request: NextRequest) => {
  if (!process.env.REVALIDATE_SECRET) {
    return NextResponse.json('REVALIDATE_SECRET is not set', { status: 501 });
  }

  const authToken = request.headers.get('Authorization');

  if (!authToken || authToken !== process.env.REVALIDATE_SECRET) {
    return NextResponse.json('Unauthorized', { status: 401 });
  }

  const tag = request.nextUrl.searchParams.get('tag');

  if (!tag) {
    return NextResponse.json('tag query parameter is required', { status: 400 });
  }

  revalidateTag(tag, 'max');

  return Response.json({ now: Date.now(), revalidated: true });
};

export const GET = withTenantRequest(handleGet);
