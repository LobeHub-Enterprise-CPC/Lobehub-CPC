import type { LobeChatDatabase } from '@lobechat/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnterpriseFileResponse } from './enterpriseProxy';
import { S3StaticFileImpl } from './impls/s3';

const mocks = vi.hoisted(() => ({ metadata: vi.fn(), stream: vi.fn() }));
vi.mock('@/server/modules/S3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  FileS3: class {
    getFileMetadata = mocks.metadata;
    getFileStream = mocks.stream;
  },
}));
vi.mock('@lobechat/database/tenant', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireTenantScope: () => ({ tenantId: 'tenant-1', slug: 'acme' }),
}));
vi.mock('@/envs/file', () => ({ fileEnv: { S3_ENABLE_PATH_STYLE: true, S3_BUCKET: 'my-bucket' } }));

describe('enterprise proxy with historical absolute storage URLs', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.metadata.mockResolvedValue({ contentLength: 10, contentType: 'application/pdf' });
    mocks.stream.mockImplementation(
      async (_key, range?: string) => new Response(range ? '23' : '0123456789').body,
    );
  });
  it.each([undefined, 'bytes=2-3'])(
    'normalizes the URL for HEAD and streaming GET (%s)',
    async (range) => {
      const impl = new S3StaticFileImpl({} as LobeChatDatabase);
      const response = await createEnterpriseFileResponse(
        new Request('https://app.test/f/file-1', { headers: range ? { Range: range } : {} }),
        {
          url: 'https://storage.test/my-bucket/t/tenant-1/files/report.pdf',
          name: 'report.pdf',
          fileType: 'application/pdf',
        },
        impl,
      );
      expect(response.status).toBe(range ? 206 : 200);
      expect(await response.text()).toBe(range ? '23' : '0123456789');
      expect(mocks.metadata).toHaveBeenCalledWith('files/report.pdf');
      expect(mocks.stream).toHaveBeenCalledWith('files/report.pdf', range, expect.any(AbortSignal));
    },
  );
});
