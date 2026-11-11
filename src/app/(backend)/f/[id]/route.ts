import debug from 'debug';
import { NextRequest } from 'next/server';

import { FileModel } from '@/database/models/file';
import { getServerDB } from '@/database/server';
import { createLambdaContext } from '@/libs/trpc/lambda/context';
import { withTenantRequest } from '@/server/modules/Tenant/gate';
import { resolveItemsScope } from '@/server/services/enterpriseKnowledge';
import { FileService } from '@/server/services/file';

const log = debug('lobe-file:proxy');

type Params = Promise<{ id: string }>;

/**
 * File proxy service
 * GET /f/:id
 *
 * Features:
 * - Query database to get file record (without userId filter for public access)
 * - Generate a temporary S3 presigned preview URL
 * - Return 302 redirect
 *
 * Non-enterprise links remain public by id. Enterprise files require the
 * request's authenticated identity and current library access before signing.
 */
const handleGet = async (req: Request, segmentData: { params: Params }) => {
  try {
    const params = await segmentData.params;
    const { id } = params;

    log('File proxy request: %s', id);

    // Get database connection
    const db = await getServerDB();

    // Query file record without userId filter (public access)
    const file = await FileModel.getFileById(db, id);

    if (!file) {
      log('File not found: %s', id);
      return new Response('File not found', {
        status: 404,
      });
    }

    // Public-by-id links remain unchanged outside enterprise libraries. Do not
    // create any storage URL before the enterprise access check has passed.
    try {
      const probe = await resolveItemsScope({ serverDB: db, userId: file.userId }, [id], 'view');
      if (probe.enterprise) {
        if (file.isDeleted) return new Response('File not found', { status: 404 });
        const identity = await createLambdaContext(new NextRequest(req));
        if (!identity.userId) return new Response('File not found', { status: 404 });
        await resolveItemsScope({ serverDB: db, userId: identity.userId }, [id], 'view');
      }
    } catch {
      return new Response('File not found', { status: 404 });
    }

    // Create file service with file owner's userId
    const fileService = new FileService(db, file.userId);

    const isDownload = new URL(req.url).searchParams.get('download') === '1';
    const redirectUrl = isDownload
      ? await fileService.createDownloadUrl(file.url, file.name)
      : await fileService.createCachedPreSignedUrlForPreview(file.url);
    log('Web S3 presigned URL generated (%s)', isDownload ? 'download' : 'preview');

    // Return 302 redirect
    return Response.redirect(redirectUrl, 302);
  } catch (error) {
    console.error('File proxy error:', error);
    return new Response('Internal server error', {
      status: 500,
    });
  }
};

export const GET = withTenantRequest(handleGet);
