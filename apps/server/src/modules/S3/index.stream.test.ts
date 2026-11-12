import { GetObjectCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { S3 } from './index';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@aws-sdk/client-s3', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  S3Client: class {
    send = mocks.send;
  },
}));
vi.mock('@lobechat/database/tenant', () => ({
  requireTenantScope: () => ({ tenantId: 'tenant-1' }),
}));

describe('S3 object streaming', () => {
  beforeEach(() => vi.resetAllMocks());
  it('passes tenant key, range and cancellation to GetObject and returns the original Web stream', async () => {
    const stream = new ReadableStream<Uint8Array>();
    const body = {
      transformToWebStream: vi.fn(() => stream),
      transformToByteArray: vi.fn(),
      transformToString: vi.fn(),
    };
    mocks.send.mockResolvedValue({ Body: body });
    const signal = new AbortController().signal;
    const service = new S3('key', 'secret', 'https://storage.test', { bucket: 'files' });
    expect(await service.getFileStream('files/a.pdf', 'bytes=3-7', signal)).toBe(stream);
    const [command, options] = mocks.send.mock.calls[0];
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: 'files',
      Key: 't/tenant-1/files/a.pdf',
      Range: 'bytes=3-7',
    });
    expect(options).toEqual({ abortSignal: signal });
    expect(body.transformToByteArray).not.toHaveBeenCalled();
    expect(body.transformToString).not.toHaveBeenCalled();
  });
});
