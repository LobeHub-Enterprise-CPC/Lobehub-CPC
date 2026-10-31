import { Receiver } from '@upstash/qstash';
import { describe, expect, it } from 'vitest';

import { signUpstashRequest } from './signature';

const signingKey = 'test-signing-key';
const body = '{"hello":"世界"}';
const url = 'https://app.example.com/orgs/acme/api/agent/run';
const receiver = new Receiver({ currentSigningKey: signingKey, nextSigningKey: signingKey });

describe('signUpstashRequest', () => {
  it('produces a QStash-compatible signature over exact body bytes and destination', async () => {
    const signature = signUpstashRequest({ body, messageId: 'message-1', signingKey, url });
    await expect(receiver.verify({ body, signature, url })).resolves.toBe(true);
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

  it.each(['body', 'key', 'expired', 'destination'])('rejects an invalid %s', async (invalid) => {
    const signature = signUpstashRequest({
      body,
      messageId: 'message-1',
      signingKey: invalid === 'key' ? 'wrong-key' : signingKey,
      url,
      now: invalid === 'expired' ? Date.now() - 600_000 : Date.now(),
    });
    const valid = await receiver
      .verify({
        body: invalid === 'body' ? body + ' ' : body,
        signature,
        url: invalid === 'destination' ? url + '/other' : url,
      })
      .catch(() => false);
    expect(valid).toBe(false);
  });
});
