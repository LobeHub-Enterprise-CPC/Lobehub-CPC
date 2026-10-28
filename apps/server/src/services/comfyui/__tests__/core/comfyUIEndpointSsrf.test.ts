// @vitest-environment node
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComfyUIClientService } from '@/server/services/comfyui/core/comfyUIClientService';

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
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.COMFYUI_BASE_URL;
  delete process.env.COMFYUI_DEFAULT_URL;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('ComfyUI endpoint SSRF guard', () => {
  it.each([
    'http://169.254.169.254:8188',
    'http://127.0.0.1:6379',
    'http://10.0.0.8:8188',
    'http://192.168.1.20:8188',
  ])('never connects to a user-provided server %s', async (baseURL) => {
    const service = new ComfyUIClientService({ baseURL });

    await expect(service.validateConnection()).rejects.toBeDefined();
    await settle();

    expect(connectTargets).toEqual([]);
  });

  it('still reaches the platform-configured ComfyUI server', async () => {
    process.env.COMFYUI_BASE_URL = 'http://127.0.0.1:18188';

    const service = new ComfyUIClientService({ baseURL: 'http://127.0.0.1:18188' });
    await expect(service.validateConnection()).rejects.toBeDefined();
    await settle();

    expect(connectTargets).toContain('127.0.0.1:18188');
  });
});
