import { describe, expect, it, vi } from 'vitest';

import { isTransientEmbeddingError, retryTransientEmbeddingError } from './embeddingRetry';

// The shapes the model runtime throws: `{ error, errorType, provider }` around the provider's answer.
const rateLimited = {
  error: { code: 'ModelAccountTpmRateLimitExceeded', message: 'TPM limit reached', status: 429 },
  errorType: 'ProviderBizError',
  provider: 'volcengine',
};
const invalidKey = {
  error: { message: 'Incorrect API key provided', status: 401 },
  errorType: 'InvalidProviderAPIKey',
};

describe('isTransientEmbeddingError', () => {
  it('recognizes a rate limit by status, by error type and by the provider code alone', () => {
    expect(isTransientEmbeddingError(rateLimited)).toBe(true);
    expect(isTransientEmbeddingError({ errorType: 'RateLimitExceeded' })).toBe(true);
    expect(
      isTransientEmbeddingError({
        error: { code: 'ModelAccountTpmRateLimitExceeded' },
        errorType: 'ProviderBizError',
      }),
    ).toBe(true);
    expect(isTransientEmbeddingError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('recognizes a provider 5xx, and nothing a retry cannot fix', () => {
    expect(
      isTransientEmbeddingError({ error: { status: 503 }, errorType: 'ProviderBizError' }),
    ).toBe(true);
    expect(isTransientEmbeddingError(invalidKey)).toBe(false);
    expect(isTransientEmbeddingError({ errorType: 'ExceededContextWindow' })).toBe(false);
    expect(isTransientEmbeddingError(undefined)).toBe(false);
  });
});

describe('retryTransientEmbeddingError', () => {
  const setup = (deadline: number) => {
    let clock = 0;
    const waits: number[] = [];
    return {
      options: {
        deadline,
        now: () => clock,
        random: () => 1,
        sleep: async (ms: number) => {
          waits.push(ms);
          clock += ms;
        },
      },
      waits,
    };
  };

  it('backs off and returns the result once the provider lets the request through', async () => {
    const { options, waits } = setup(10 * 60_000);
    const onRetry = vi.fn();
    const request = vi
      .fn()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(rateLimited)
      .mockResolvedValue([[0.1]]);

    await expect(retryTransientEmbeddingError(request, { ...options, onRetry })).resolves.toEqual([
      [0.1],
    ]);

    expect(request).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 4000]);
    expect(onRetry.mock.calls.map(([info]) => [info.attempt, info.delayMs])).toEqual([
      [1, 2000],
      [2, 4000],
    ]);
  });

  it('never waits longer than a minute between attempts', async () => {
    const { options, waits } = setup(30 * 60_000);
    const request = vi.fn();
    for (let i = 0; i < 8; i++) request.mockRejectedValueOnce(rateLimited);
    request.mockResolvedValue([]);

    await retryTransientEmbeddingError(request, options);

    expect(waits).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it('gives up with the provider error once the next wait would pass the deadline', async () => {
    const { options, waits } = setup(10_000);
    const request = vi.fn().mockRejectedValue(rateLimited);

    await expect(retryTransientEmbeddingError(request, options)).rejects.toBe(rateLimited);

    // 2s + 4s waited; a further 8s would end after the 10s deadline.
    expect(waits).toEqual([2000, 4000]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that will not pass', async () => {
    const { options, waits } = setup(10 * 60_000);
    const request = vi.fn().mockRejectedValue(invalidKey);

    await expect(retryTransientEmbeddingError(request, options)).rejects.toBe(invalidKey);

    expect(request).toHaveBeenCalledTimes(1);
    expect(waits).toEqual([]);
  });
});
