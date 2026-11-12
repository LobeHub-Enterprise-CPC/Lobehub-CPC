import { isRecord } from '@lobechat/utils/object';

import type { FileItem } from '@/database/schemas';
import { encodeContentDispositionFilename } from '@/server/modules/S3';

import type { FileService } from './index';

/** Only a single byte range is supported; never buffer multipart or whole objects. */
const resolveRange = (value: string, size: number) => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const total = BigInt(size);
  const last = total - 1n;
  const start = match[1]
    ? BigInt(match[1])
    : total > BigInt(match[2])
      ? total - BigInt(match[2])
      : 0n;
  const requestedEnd = match[1] && match[2] ? BigInt(match[2]) : last;
  const end = requestedEnd < last ? requestedEnd : last;
  if ((!match[1] && BigInt(match[2]) === 0n) || start > end) return null;
  return { end: Number(end), start: Number(start) };
};

export const createEnterpriseFileResponse = async (
  request: Request,
  file: Pick<FileItem, 'url' | 'name' | 'fileType'>,
  service: Pick<FileService, 'getFileMetadata' | 'getFileStream'>,
) => {
  const missing = () =>
    new Response('File not found', {
      headers: { 'Cache-Control': 'private, no-store' },
      status: 404,
    });
  if (file.url.startsWith('internal://')) return missing();
  try {
    const metadata = await service.getFileMetadata(file.url);
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': 'sandbox',
      'Content-Type': metadata.contentType || file.fileType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    const disposition =
      new URL(request.url).searchParams.get('download') === '1' ? 'attachment' : 'inline';
    headers.set(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodeContentDispositionFilename(file.name)}`,
    );

    const rangeHeader = request.headers.get('range');
    const range =
      rangeHeader === null ? undefined : resolveRange(rangeHeader, metadata.contentLength);
    if (range === null) {
      headers.set('Content-Range', `bytes */${metadata.contentLength}`);
      headers.set('Content-Length', '0');
      return new Response(null, { headers, status: 416 });
    }

    headers.set(
      'Content-Length',
      String(range ? range.end - range.start + 1 : metadata.contentLength),
    );
    if (range)
      headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.contentLength}`);
    const body = await service.getFileStream(
      file.url,
      range ? `bytes=${range.start}-${range.end}` : undefined,
      request.signal,
    );
    return new Response(body, { headers, status: range ? 206 : 200 });
  } catch (error) {
    const metadata = isRecord(error) && isRecord(error.$metadata) ? error.$metadata : undefined;
    if (
      isRecord(error) &&
      (error.name === 'NoSuchKey' ||
        error.name === 'NotFound' ||
        error.Code === 'NoSuchKey' ||
        metadata?.httpStatusCode === 404)
    )
      return missing();
    // Keys and upstream storage errors must not appear in a browser response.
    console.error('Enterprise file storage request failed', error);
    return new Response('Internal server error', {
      headers: { 'Cache-Control': 'private, no-store' },
      status: 500,
    });
  }
};
