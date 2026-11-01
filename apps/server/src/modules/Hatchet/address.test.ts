import { describe, expect, it } from 'vitest';

import { resolveDeliveryTarget } from './address';

const env = {
  appUrl: 'https://app.example.com',
  internalAppUrl: 'http://internal.example.com:3210',
  agentRuntimeBaseUrl: 'https://runtime.example.com/base',
  port: '4321',
};

describe('resolveDeliveryTarget', () => {
  it.each([env.appUrl, env.internalAppUrl, 'https://runtime.example.com'])(
    'routes a tenant callback on %s through loopback and internal authority',
    (origin) => {
      const target = resolveDeliveryTarget(origin + '/orgs/acme/api/agent/run?a=1&b=2', env);
      expect(target).toEqual({
        loopback: true,
        host: 'internal.example.com:3210',
        url: new URL('http://127.0.0.1:4321/orgs/acme/api/agent/run?a=1&b=2'),
      });
    },
  );
  it.each(['/orgs/acme/settings', '/api/agent/run', '/orgs/acme/api/agent/runaway'])(
    'preserves original authority outside tenant callback whitelist: %s',
    (path) => {
      expect(resolveDeliveryTarget(env.appUrl + path, env)).toMatchObject({
        loopback: true,
        host: 'app.example.com',
      });
    },
  );
  it('leaves external origins unchanged', () => {
    const url = 'https://external.example.com/path?q=1';
    expect(resolveDeliveryTarget(url, env)).toEqual({ loopback: false, url: new URL(url) });
    expect(resolveDeliveryTarget('http://app.example.com/path', env).loopback).toBe(false);
    expect(resolveDeliveryTarget('https://app.example.com:444/path', env).loopback).toBe(false);
  });
  it.each([
    [undefined, '127.0.0.1'],
    ['', '127.0.0.1'],
    ['0.0.0.0', '127.0.0.1'],
    ['::', '[::1]'],
    ['::1', '[::1]'],
    ['[::1]', '[::1]'],
    ['2001:db8::1', '[2001:db8::1]'],
    ['127.0.0.2', '127.0.0.2'],
    ['server', 'server'],
  ])('connects to hostname %j', (hostname, expected) => {
    const target = resolveDeliveryTarget(env.appUrl + '/path', { ...env, hostname });
    expect(target.url.href).toBe('http://' + expected + ':4321/path');
  });
  it.each([
    'ftp://app.example.com/a',
    'file:///etc/passwd',
    'https://user:secret@app.example.com/a',
    'https://user@app.example.com/a',
  ])('rejects unsupported or credential-bearing URL %s', (url) => {
    expect(() => resolveDeliveryTarget(url, env)).toThrow();
  });
});
