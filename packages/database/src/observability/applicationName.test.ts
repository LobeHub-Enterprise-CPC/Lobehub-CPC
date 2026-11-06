// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildDbApplicationName, dbApplicationName } from './applicationName';

const os = vi.hoisted(() => ({ hostname: vi.fn(() => 'tituwork-memory-worker-7d9c-abcde') }));
vi.mock('node:os', () => ({ default: os, hostname: os.hostname }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildDbApplicationName', () => {
  it('names service, pod suffix, pid, purpose and version', () => {
    expect(
      buildDbApplicationName({
        hostname: 'tituwork-executor-6b8f9c7d5-x2k9p',
        pid: 1,
        purpose: 'tenant',
        service: 'executor',
        version: '2.2.20',
      }),
    ).toBe('tw-executor/x2k9p/1/tenant/2.2.20');
  });

  it('omits a missing version and falls back for a missing service or host', () => {
    expect(buildDbApplicationName({ pid: 42, purpose: 'migrate' })).toBe('tw-node/-/42/migrate');
  });

  it('stays short ASCII within 63 bytes whatever the inputs', () => {
    const name = buildDbApplicationName({
      hostname: 'pod-名字-ä',
      pid: 2_147_483_647,
      purpose: 'channel-coordinator-with-a-long-tail',
      service: 'a-service/name with spaces and ünïcode that is far too long',
      version: '2.2.20-canary.123456',
    });
    expect(name).toMatch(/^[\w./-]+$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
    // Separators come only from the format: one per segment boundary.
    expect(name.split('/')).toHaveLength(5);
    expect(name.split('/')[3]).toBe('channel-coordinator');
  });
});

describe('dbApplicationName', () => {
  it('reads DB_APP_SERVICE from the environment and the pod name from the OS', () => {
    vi.stubEnv('DB_APP_SERVICE', 'memory-worker');
    // The image sets HOSTNAME=0.0.0.0 as the Next bind address; it is not the pod name.
    vi.stubEnv('HOSTNAME', '0.0.0.0');
    expect(dbApplicationName('platform')).toMatch(
      new RegExp(`^tw-memory-worker/abcde/${process.pid}/platform/[\\w.-]+$`),
    );
  });

  it.each([
    ['tituwork-558c7f97cc-h8fmn', 'web'],
    ['tituwork-executor-6576c485dc-rlccf', 'executor'],
    ['tituwork-worker-7666bff7bf-9ldzb', 'worker'],
    ['tituwork-memory-worker-5b7f85c9cd-g596m', 'memory-worker'],
    ['tituwork-fts-sync-29899059-jjrmt', 'fts-sync'],
  ])('names the service after the Deployment of pod %s', (pod, service) => {
    vi.stubEnv('DB_APP_SERVICE', '');
    os.hostname.mockReturnValueOnce(pod).mockReturnValueOnce(pod);
    expect(dbApplicationName('tenant')).toMatch(new RegExp(`^tw-${service}/${pod.slice(-5)}/`));
  });

  it('falls back to the entry script name for the service', () => {
    vi.stubEnv('DB_APP_SERVICE', '');
    os.hostname.mockReturnValueOnce('mocha-dev').mockReturnValueOnce('mocha-dev');
    const argv = vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', '/app/server.js']);
    expect(dbApplicationName('tenant')).toMatch(/^tw-server\//);
    argv.mockRestore();
  });
});
