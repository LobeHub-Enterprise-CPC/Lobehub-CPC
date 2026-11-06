// @vitest-environment node
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { serveWorkerHealth } from './health';

type Server = Awaited<ReturnType<typeof serveWorkerHealth>>;
const servers: Server[] = [];
const get = async (server: Server, path: string) => {
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`);
};

describe('serveWorkerHealth', () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  it('is ready only while the workers are serving', async () => {
    let serving = false;
    const server = await serveWorkerHealth(0, () => serving);
    servers.push(server);

    const before = await get(server, '/healthz');
    expect(before.status).toBe(503);
    expect(await before.json()).toEqual({ status: 'not-ready' });

    serving = true;
    const after = await get(server, '/healthz');
    expect(after.status).toBe(200);
    expect(after.headers.get('cache-control')).toBe('no-store');
    expect(await after.json()).toEqual({ status: 'ready' });
  });

  it('answers nothing else', async () => {
    const server = await serveWorkerHealth(0, () => true);
    servers.push(server);

    expect((await get(server, '/')).status).toBe(404);
  });

  it('rejects when the port cannot be bound, so the caller starts no worker', async () => {
    const taken = await serveWorkerHealth(0, () => true);
    servers.push(taken);
    const { port } = taken.address() as AddressInfo;

    await expect(serveWorkerHealth(port, () => true)).rejects.toThrow();
  });

  it('is not ready when the check itself fails', async () => {
    const server = await serveWorkerHealth(0, () => {
      throw new Error('boom');
    });
    servers.push(server);

    expect((await get(server, '/healthz')).status).toBe(503);
  });
});
