// @vitest-environment node
import net from 'node:net';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestAttachment } from './ingestAttachment';

const businessFileUploadCheck = vi.hoisted(() => vi.fn());

vi.mock('@/business/server/lambda-routers/file', () => ({
  businessFileTransferStorageCheck: vi.fn(),
  businessFileUploadCheck,
}));

const createFileService = () =>
  ({
    getFileAccessUrl: vi.fn().mockResolvedValue('https://cdn.test/a.pdf'),
    uploadFromBuffer: vi.fn().mockResolvedValue({ fileId: 'file-1', key: 'files/key' }),
  }) as any;

const source = () => ({
  buffer: Buffer.alloc(2048),
  mimeType: 'application/pdf',
  name: 'report.pdf',
  size: 4096,
});

describe('ingestAttachment storage quota', () => {
  beforeEach(() => {
    businessFileUploadCheck.mockReset().mockResolvedValue(undefined);
  });

  it('charges the stored buffer length against the caller workspace', async () => {
    const fileService = createFileService();

    await ingestAttachment(source(), fileService, 'user-1', 'ws-1');

    expect(businessFileUploadCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        actualSize: 2048,
        inputSize: 4096,
        userId: 'user-1',
        workspaceId: 'ws-1',
      }),
    );
    expect(fileService.uploadFromBuffer).toHaveBeenCalled();
  });

  it('never writes to storage when the quota check rejects', async () => {
    const fileService = createFileService();
    businessFileUploadCheck.mockRejectedValue(
      Object.assign(new Error('File storage is beyond the plan limit'), { code: 'FORBIDDEN' }),
    );

    await expect(ingestAttachment(source(), fileService, 'user-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fileService.uploadFromBuffer).not.toHaveBeenCalled();
  });
});

describe('ingestAttachment object key', () => {
  beforeEach(() => {
    businessFileUploadCheck.mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['../../other-user/x.pdf', '.._.._other-user_x.pdf'],
    ['a\\b.pdf', 'a_b.pdf'],
    ['line\nbreak.pdf', 'line_break.pdf'],
    ['..', 'file.bin'],
    ['', 'file.bin'],
  ])('stores the platform file name %j as a single safe segment', async (name, stored) => {
    const fileService = createFileService();

    await ingestAttachment({ ...source(), name }, fileService, 'user-1');

    const pathname: string = fileService.uploadFromBuffer.mock.calls[0][2];
    expect(pathname).toMatch(/^files\/user-1\/[^/]+\/[^/]+$/);
    expect(pathname.split('/').at(-1)).toBe(stored);
  });
});

describe('ingestAttachment url source', () => {
  it('does not fetch an attachment URL that points at a private or metadata address', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket,
    ) {
      this.destroy(new Error('network disabled in test'));
      return this;
    } as any);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const url of [
        'http://169.254.169.254/latest/meta-data',
        'http://127.0.0.1:8080/a.png',
      ]) {
        await expect(
          ingestAttachment({ name: 'a.png', url }, createFileService(), 'user-1'),
        ).rejects.toBeDefined();
      }

      expect(connect).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
