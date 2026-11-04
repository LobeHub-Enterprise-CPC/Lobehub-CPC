import { describe, expect, it } from 'vitest';

import { signUpstashRequest, verifyDeliverySignature } from './signature';

const signingKey = 'test-signing-key';
const body = '{"hello":"世界"}';
const url = 'https://app.example.com/orgs/acme/api/agent/run';

describe('signUpstashRequest / verifyDeliverySignature', () => {
  it('signs exact body bytes and destination, and verifies them', () => {
    const signature = signUpstashRequest({ body, messageId: 'message-1', signingKey, url });
    expect(verifyDeliverySignature({ body, signature, signingKey, url })).toBe(true);
    expect(verifyDeliverySignature({ body, signature, signingKey })).toBe(true);
    const [header, payload] = signature
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
    expect(header).toEqual({ alg: 'HS256', typ: 'JWT' });
    expect(payload).toMatchObject({ iss: 'Upstash', sub: url, jti: 'message-1' });
    expect(payload.exp - payload.iat).toBe(300);
    expect(payload.nbf).toBe(payload.iat);
    expect(signature).not.toContain('=');
  });

  it.each(['body', 'key', 'expired', 'destination', 'mac'])('rejects an invalid %s', (invalid) => {
    const signature = signUpstashRequest({
      body,
      messageId: 'message-1',
      signingKey: invalid === 'key' ? 'wrong-key' : signingKey,
      url,
      now: invalid === 'expired' ? Date.now() - 600_000 : Date.now(),
    });
    const valid = verifyDeliverySignature({
      body: invalid === 'body' ? body + ' ' : body,
      signature: invalid === 'mac' ? signature.slice(0, -2) + 'AA' : signature,
      signingKey,
      url: invalid === 'destination' ? url + '/other' : url,
    });
    expect(valid).toBe(false);
  });
});

it('rejects tokens that are not three parts or carry another algorithm', () => {
  expect(verifyDeliverySignature({ body, signature: 'a.b', signingKey })).toBe(false);
  const signature = signUpstashRequest({ body, messageId: 'm', signingKey, url });
  const [, payload, mac] = signature.split('.');
  const none = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  expect(
    verifyDeliverySignature({ body, signature: [none, payload, mac].join('.'), signingKey }),
  ).toBe(false);
});
