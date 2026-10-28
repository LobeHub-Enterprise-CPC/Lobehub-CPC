// @vitest-environment node
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoGenerationService } from './video';

vi.mock('@/server/services/file', () => ({ FileService: vi.fn() }));

const connectTargets: string[] = [];

beforeEach(() => {
  connectTargets.length = 0;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
    this: net.Socket,
    ...args: any[]
  ) {
    // net.connect() hands the normalized `[options, cb]` pair through as one array.
    const [first] = Array.isArray(args[0]) ? args[0] : args;
    connectTargets.push(`${first?.host}:${first?.port}`);
    this.destroy(new Error('network disabled in test'));
    return this;
  } as any);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VideoGenerationService video download', () => {
  // The video URL comes back from the (tenant-configurable) model provider, and the
  // download carries the provider credential in its headers.
  it.each([
    'http://169.254.169.254/latest/meta-data/video.mp4',
    'http://127.0.0.1:8080/video.mp4',
    'http://192.168.1.10/video.mp4',
  ])('never connects to a provider-returned URL %s', async (url) => {
    const service = new VideoGenerationService({} as any, 'user-id');

    await expect(
      service.processVideoForGeneration(url, { headers: { Authorization: 'Bearer secret' } }),
    ).rejects.toThrow();

    expect(connectTargets).toEqual([]);
  });
});
