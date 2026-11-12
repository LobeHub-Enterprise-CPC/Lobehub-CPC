// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EnterpriseKbContentService } from './content';
import type * as Shared from './shared';

const mocks = vi.hoisted(() => ({
  createPreSignedUpload: vi.fn(async () => ({
    headers: undefined,
    url: 'https://storage.test/put',
  })),
}));

vi.mock('./shared', async (original) => ({
  ...(await original<typeof Shared>()),
  loadEnterpriseKb: vi.fn(async () => ({ id: 'kb-1', userId: 'owner-1' })),
}));
vi.mock('@/server/services/file', () => ({
  FileService: vi.fn().mockImplementation(function () {
    return { createPreSignedUpload: mocks.createPreSignedUpload };
  }),
}));
vi.mock('@/server/services/fileUpload', () => ({
  FileUploadService: vi.fn().mockImplementation(function () {
    return { model: {} };
  }),
}));
vi.mock('@/server/services/fileUploadReservation', () => ({
  reserveUpload: vi.fn(async () => ({ id: 'reservation-1' })),
}));

describe('EnterpriseKbContentService.presign', () => {
  beforeEach(() => vi.clearAllMocks());

  it('signs enterprise uploads as private so the object is never publicly readable', async () => {
    // With S3_SET_ACL on, a default upload would be public-read and bypass the
    // authenticated file proxy; enterprise objects must opt out.
    await new EnterpriseKbContentService({} as never).presign('kb-1', {
      contentType: 'text/plain',
      name: 'manual.md',
      size: 10,
    });
    expect(mocks.createPreSignedUpload).toHaveBeenCalledWith(
      expect.stringMatching(/^files\/owner-1\/enterprise-kb\/kb-1\//),
      { private: true },
    );
  });
});
