// @vitest-environment node
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ContentAccess from '@/server/services/enterpriseKnowledge/contentAccess';

import { GET } from './route';

const mocks = vi.hoisted(() => ({
  file: {
    id: 'file-1',
    fileType: 'application/pdf',
    name: "报告(1)'.pdf",
    url: 'files/report.pdf',
    userId: 'owner',
  },
  identity: vi.fn(),
  scopes: vi.fn(),
  preview: vi.fn(),
  download: vi.fn(),
  metadata: vi.fn(),
  stream: vi.fn(),
}));
vi.mock('@/server/modules/Tenant/gate', () => ({
  withTenantRequest: (handler: unknown) => handler,
}));
vi.mock('@/database/server', () => ({ getServerDB: async () => ({}) }));
vi.mock('@/database/models/file', () => ({ FileModel: { getFileById: async () => mocks.file } }));
vi.mock('@/libs/trpc/lambda/context', () => ({ createLambdaContext: mocks.identity }));
vi.mock('@/server/services/enterpriseKnowledge/contentAccess', async (original) => ({
  ...(await original<typeof ContentAccess>()),
  resolveEnterpriseContentScopes: mocks.scopes,
}));
vi.mock('@/server/services/file', () => ({
  FileService: class {
    createCachedPreSignedUrlForPreview = mocks.preview;
    createDownloadUrl = mocks.download;
    getFileMetadata = mocks.metadata;
    getFileStream = mocks.stream;
  },
}));

const request = (range?: string, download = false) =>
  GET(
    new NextRequest(`https://app.test/f/file-1${download ? '?download=1' : ''}`, {
      headers: range === undefined ? {} : { Range: range },
    }),
    { params: Promise.resolve({ id: 'file-1' }) },
  );

describe('enterprise file bytes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.identity.mockResolvedValue({ userId: 'viewer' });
    mocks.scopes.mockResolvedValue(new Map([['file-1', 'owner']]));
    mocks.metadata.mockResolvedValue({ contentLength: 10, contentType: 'text/html' });
    mocks.stream.mockImplementation(async (_key, range?: string) => {
      const match = range?.match(/bytes=(\d+)-(\d+)/);
      const bytes = '0123456789'.slice(
        match ? Number(match[1]) : 0,
        match ? Number(match[2]) + 1 : 10,
      );
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(bytes));
          controller.close();
        },
      });
    });
    mocks.preview.mockResolvedValue('https://storage.test/preview');
    mocks.download.mockResolvedValue('https://storage.test/download');
  });

  it('authorizes a request wrapped by the tenant gate proxy without rebuilding it', async () => {
    // The tenant gate hands handlers a Proxy over NextRequest; NextRequest cannot be
    // reconstructed from it, so the route must pass the request through unchanged.
    const original = new NextRequest('https://app.test/orgs/acme/f/file-1');
    const wrapped = new Proxy(original, {
      get: (target, key) => {
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await GET(wrapped, { params: Promise.resolve({ id: 'file-1' }) });
    expect(response.status).toBe(200);
    expect(mocks.identity).toHaveBeenCalledWith(wrapped);
  });

  it('streams bytes with private sandboxed headers and no storage URL', async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'accept-ranges': 'bytes',
      'cache-control': 'private, no-store',
      'content-length': '10',
      'content-security-policy': 'sandbox',
      'content-type': 'text/html',
      'x-content-type-options': 'nosniff',
    });
    expect(response.headers.get('content-disposition')).toMatch(/^inline; filename\*=UTF-8''/);
    expect(response.headers.get('location')).toBeNull();
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it('returns the response before the storage stream has finished', async () => {
    const stream = new ReadableStream<Uint8Array>();
    mocks.stream.mockResolvedValue(stream);
    const response = await request();
    expect(response.body).toBe(stream);
    await response.body!.cancel();
  });

  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=8-999999999999999999999', '89', 'bytes 8-9/10'],
    ['bytes=-20', '0123456789', 'bytes 0-9/10'],
  ])('serves a single range %s', async (range, bytes, contentRange) => {
    const response = await request(range);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(bytes);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
  });

  it.each([
    'bytes=10-',
    'bytes=5-2',
    'bytes=-0',
    'bytes=',
    'items=1-2',
    'bytes=0-1,3-4',
    'bytes=a-b',
  ])('rejects invalid or unsatisfiable range %s', async (range) => {
    const response = await request(range);
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('uses the record MIME fallback and RFC 5987 attachment name', async () => {
    mocks.metadata.mockResolvedValue({ contentLength: 10 });
    const response = await request(undefined, true);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A%281%29%27.pdf",
    );
  });

  it('authorizes the same URL again after access is revoked', async () => {
    expect((await request()).status).toBe(200);
    mocks.scopes.mockImplementation(async (ctx: { userId: string }) => {
      if (ctx.userId === 'viewer') throw new Error('revoked');
      return new Map([['file-1', 'owner']]);
    });
    mocks.stream.mockClear();
    const response = await request('bytes=0-1');
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('File not found');
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('hides enterprise files from anonymous callers', async () => {
    mocks.identity.mockResolvedValue({ userId: null });
    expect((await request()).status).toBe(404);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it('returns a private 404 for native documents without touching storage', async () => {
    const original = mocks.file.url;
    try {
      mocks.file.url = 'internal://document/placeholder';
      const response = await request();
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(mocks.metadata).not.toHaveBeenCalled();
      expect(mocks.stream).not.toHaveBeenCalled();
    } finally {
      mocks.file.url = original;
    }
  });

  it.each(['metadata', 'stream'] as const)(
    'maps missing storage objects during %s to 404',
    async (stage) => {
      mocks[stage].mockRejectedValue(
        Object.assign(new Error('private/key'), { name: 'NoSuchKey' }),
      );
      const response = await request();
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('File not found');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    },
  );

  it('maps storage HTTP 404 to a private 404', async () => {
    mocks.metadata.mockRejectedValue({ $metadata: { httpStatusCode: 404 } });
    expect((await request()).status).toBe(404);
  });

  it('keeps other storage errors generic', async () => {
    mocks.metadata.mockRejectedValue(new Error('private/object/key'));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal server error');
  });

  it('preserves public redirects for non-enterprise files', async () => {
    mocks.scopes.mockResolvedValue(new Map());
    expect((await request()).headers.get('location')).toBe('https://storage.test/preview');
    expect((await request(undefined, true)).headers.get('location')).toBe(
      'https://storage.test/download',
    );
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.stream).not.toHaveBeenCalled();
  });
});
