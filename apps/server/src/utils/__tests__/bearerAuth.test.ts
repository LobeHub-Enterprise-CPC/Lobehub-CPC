// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { isBearerSecret, secretsEqual } from '../bearerAuth';

describe('isBearerSecret', () => {
  it('accepts exactly `Bearer <secret>`', () => {
    expect(isBearerSecret('Bearer s3cret', 's3cret')).toBe(true);
  });

  it.each([
    ['missing header', undefined],
    ['null header', null],
    ['empty header', ''],
    ['wrong secret', 'Bearer other'],
    ['prefix of the secret', 'Bearer s3cre'],
    ['secret with a suffix', 'Bearer s3cret!'],
    ['no scheme', 's3cret'],
    ['other scheme', 'Basic s3cret'],
    ['lowercase scheme', 'bearer s3cret'],
  ])('rejects %s', (_name, header) => {
    expect(isBearerSecret(header, 's3cret')).toBe(false);
  });
});

describe('secretsEqual', () => {
  it('compares values of different length without throwing', () => {
    expect(secretsEqual('a', 'a-much-longer-value')).toBe(false);
    expect(secretsEqual('same', 'same')).toBe(true);
  });
});
