import { createServer, type Server } from 'node:http';

/**
 * Answers `GET /healthz` with 200 while `ready()` holds and 503 otherwise, for a readiness
 * probe that has to see the Hatchet workers rather than the web server. Resolves once it
 * listens and rejects if it cannot, so a caller can refuse to take work without a readiness
 * check. It never keeps the process up by itself.
 */
export const serveWorkerHealth = (port: number, ready: () => boolean): Promise<Server> => {
  const server = createServer((request, response) => {
    if (request.url !== '/healthz') {
      response.writeHead(404).end();
      return;
    }
    let ok = false;
    try {
      ok = ready();
    } catch (error) {
      console.error('[Hatchet] worker health check failed', error);
    }
    response.writeHead(ok ? 200 : 503, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
    });
    response.end(JSON.stringify({ status: ok ? 'ready' : 'not-ready' }));
  });
  server.unref();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      server.on('error', (error) => console.error('[Hatchet] worker health server failed', error));
      resolve(server);
    });
  });
};
