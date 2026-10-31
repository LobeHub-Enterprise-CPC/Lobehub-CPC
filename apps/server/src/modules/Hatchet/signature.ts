import { createHash, createHmac } from 'node:crypto';

interface SigningInput {
  body: string;
  messageId: string;
  now?: number;
  signingKey: string;
  url: string;
}

export const signUpstashRequest = ({
  body,
  url,
  messageId,
  signingKey,
  now = Date.now(),
}: SigningInput): string => {
  const iat = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'Upstash',
      sub: url,
      iat,
      nbf: iat,
      exp: iat + 300,
      jti: messageId,
      body: createHash('sha256').update(body).digest('base64url'),
    }),
  ).toString('base64url');
  const data = header + '.' + payload;
  return data + '.' + createHmac('sha256', signingKey).update(data).digest('base64url');
};
