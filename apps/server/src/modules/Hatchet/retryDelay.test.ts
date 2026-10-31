import { describe, expect, it } from 'vitest';

import { compileRetryDelay, defaultRetryDelayMs, parseRetryAfter } from './retryDelay';

describe('compileRetryDelay', () => {
  it.each([
    ['60000', 0, 60000],
    ['10000 * (1 + retried)', 2, 30000],
    ['pow(2, retried) * 1000', 0, 1000],
    ['min(8, 2, 5)', 0, 2],
    ['max(8, 2, 5)', 0, 8],
    ['-2 * -3 + 8 / 4 - .5', 0, 7.5],
    ['sqrt(9) + abs(-2) + floor(1.9) + ceil(1.1) + round(1.6) + exp(0)', 0, 11],
  ])('evaluates %s', (expression, retried, expected) => {
    expect(compileRetryDelay(expression)(retried)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    'other',
    'Math.exp(1)',
    'retried.foo',
    '1;2',
    '1 2',
    '2 ** 3',
    'pow(2)',
    'sqrt(1,2)',
    'min()',
    'max(1,)',
    '()',
    '(1',
    '1)',
    '+1',
    '1e3',
    'constructor(1)',
    '1 +',
    'retried(1)',
    '1 @ 2',
  ])('rejects %j at compile time', (expr) => {
    expect(() => compileRetryDelay(expr)).toThrow();
  });

  it.each(['-1', '1 / 0', 'sqrt(-1)', 'exp(10000)'])('rejects invalid result %s', (expr) => {
    expect(() => compileRetryDelay(expr)(0)).toThrow();
  });
});

describe('defaultRetryDelayMs', () => {
  it('uses a one-based retry number and caps at one day', () => {
    expect(defaultRetryDelayMs(1)).toBeCloseTo(12182.49396, 3);
    expect(defaultRetryDelayMs(20)).toBe(86_400_000);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-30T00:00:00Z');
  it.each([
    ['90', 90000],
    ['Fri, 30 Oct 2026 00:01:00 GMT', 60000],
    ['6m5s', 365000],
    ['90s', 90000],
    ['1h', 3600000],
    ['1.5s', 1500],
    ['0', 0],
    [' 2 ', 2000],
  ])('parses %s', (value, expected) => {
    expect(parseRetryAfter(value, now)).toBe(expected);
  });
  it.each([
    '-1',
    '-1s',
    'invalid',
    '',
    '1.5',
    '5s garbage',
    '1h-2m',
    'Thu, 29 Oct 2026 00:00:00 GMT',
    'Infinity',
  ])('rejects %j', (value) => {
    expect(parseRetryAfter(value, now)).toBeUndefined();
  });
});
