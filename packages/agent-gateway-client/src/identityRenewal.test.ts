import { readFile } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { testConfirmation, testTicket } from './__tests__/fixtures';
import { GatewayIdentityRenewal } from './identityRenewal';
import { gatewayIdentityHint, GatewaySocketAuthority } from './tenancy';

const fixtures = JSON.parse(
  await readFile('contracts/gateway-tenancy/v1/fixtures/authorize.json', 'utf8').catch(() =>
    readFile('../../contracts/gateway-tenancy/v1/fixtures/authorize.json', 'utf8'),
  ),
);
const renewals: GatewayIdentityRenewal[] = [];
const setup = (provider?: any) => {
  const now = Date.now();
  const identity = {
    ...gatewayIdentityHint(testTicket(), 'urn:lobehub:gateway:agent', 'op-123'),
    ticketExpiresAt: now + 10000,
    authRecordExpiresAt: now + 10000,
  };
  const next = {
    ...identity,
    gatewayTicket: 'TEST-ONLY-RENEWED',
    ticketExpiresAt: now + 20000,
    authRecordExpiresAt: now + 20000,
  };
  const authority = new GatewaySocketAuthority(identity, 'urn:lobehub:gateway:agent', 'op-123');
  const options = {
    authority,
    provider: provider === null ? undefined : (provider ?? vi.fn(async () => next)),
    isCurrent: () => true,
    sendAuth: vi.fn(),
    onFailed: vi.fn(),
    onExpired: vi.fn(),
    onTemporary: vi.fn(),
  };
  const renewal = new GatewayIdentityRenewal(options);
  renewals.push(renewal);
  const frame = {
    ...testConfirmation(),
    ticketExpiresAt: identity.ticketExpiresAt,
    authRecordExpiresAt: identity.authRecordExpiresAt,
  };
  renewal.confirm(frame);
  return { renewal, authority, options, next, identity, frame };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  renewals.splice(0).forEach((renewal) => renewal.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('shared proactive identity renewal', () => {
  it('keeps the candidate unpublished until generation+1 confirmation', async () => {
    const { renewal, authority, options, next, frame, identity } = setup();
    await vi.advanceTimersByTimeAsync(4999);
    expect(options.sendAuth).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(options.provider).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      renewAuthorizationId: identity.authorizationId,
    });
    expect(options.sendAuth).toHaveBeenCalledOnce();
    expect(renewal.authority).toBe(authority);
    expect(
      renewal.confirm({
        ...frame,
        connectionGeneration: 2,
        ticketExpiresAt: next.ticketExpiresAt,
        authRecordExpiresAt: next.authRecordExpiresAt,
      }),
    ).toBe(true);
    expect(authority.signal.aborted).toBe(true);
    expect(renewal.authority.identity.authorizationId).toBe(identity.authorizationId);
    expect(renewal.authority.alive()).toBe(true);
  });
  it('rejects the frozen A2 changed-authorization response fixture', async () => {
    const fixture = fixtures.cases.find(
      (item: { id: string }) => item.id === 'a2-changed-authorization-response',
    );
    const { options, next } = setup();
    vi.mocked(options.provider!).mockResolvedValue({
      ...next,
      authorizationId: fixture.context.returnedAuthorizationId,
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(options.onFailed).toHaveBeenCalledWith(fixture.expected.code);
    expect(options.sendAuth).not.toHaveBeenCalled();
  });
  it.each(['SOURCE_UNVERIFIABLE', 'GATEWAY_TENANCY_UNSUPPORTED', 'TENANT_EXECUTION_VERSION_STALE'])(
    'terminates a permanent renewal failure: %s',
    async (code) => {
      const provider = vi.fn().mockRejectedValue(new Error(code));
      const { options } = setup(provider);
      await vi.advanceTimersByTimeAsync(10000);
      expect(provider).toHaveBeenCalledOnce();
      expect(options.onFailed).toHaveBeenCalledWith(code);
      expect(options.onExpired).not.toHaveBeenCalled();
    },
  );
  it('retries a temporary failure before the old cutoff and never extends without ack', async () => {
    const provider = vi.fn().mockRejectedValue(new Error('GATEWAY_AUTHORITY_UNAVAILABLE'));
    const { options, next, renewal, authority } = setup(provider);
    await vi.advanceTimersByTimeAsync(5000);
    provider.mockResolvedValue(next);
    await vi.advanceTimersByTimeAsync(1000);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(options.onTemporary).toHaveBeenCalledWith('GATEWAY_AUTHORITY_UNAVAILABLE');
    expect(renewal.authority).toBe(authority);
    await vi.advanceTimersByTimeAsync(3750);
    expect(options.onExpired).toHaveBeenCalledOnce();
    expect(renewal.authority).toBe(authority);
  });
  it.each(['resolve', 'reject'])(
    'ignores a provider that completes after disposal: %s',
    async (result) => {
      let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
      const provider = vi.fn(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      );
      const { renewal, options, next } = setup(provider);
      await vi.advanceTimersByTimeAsync(5000);
      renewal.dispose();
      if (result === 'resolve') resolve(next);
      else reject(new Error('SOURCE_UNVERIFIABLE'));
      await vi.advanceTimersByTimeAsync(0);
      expect(options.sendAuth).not.toHaveBeenCalled();
      expect(options.onFailed).not.toHaveBeenCalled();
    },
  );
  it('aborts a hanging provider at the absolute cutoff', async () => {
    let signal!: AbortSignal;
    const { options } = setup(({ signal: input }: { signal: AbortSignal }) => {
      signal = input;
      return new Promise(() => {});
    });
    await vi.advanceTimersByTimeAsync(9750);
    expect(signal.aborted).toBe(true);
    expect(options.onExpired).toHaveBeenCalledOnce();
    expect(options.sendAuth).not.toHaveBeenCalled();
  });
  it('does not revive permission after sleep passes the deadline', async () => {
    const { options } = setup();
    vi.setSystemTime(Date.now() + 20000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(options.provider).not.toHaveBeenCalled();
    expect(options.onExpired).toHaveBeenCalledOnce();
  });
  it('never fabricates a renewal when no provider exists', async () => {
    const { options, authority } = setup(null);
    await vi.advanceTimersByTimeAsync(10000);
    expect(options.sendAuth).not.toHaveBeenCalled();
    expect(authority.alive()).toBe(false);
  });
  it('rejects an unexpected candidate generation', async () => {
    const { renewal, frame, next } = setup();
    await vi.advanceTimersByTimeAsync(5000);
    expect(() =>
      renewal.confirm({
        ...frame,
        connectionGeneration: 3,
        ticketExpiresAt: next.ticketExpiresAt,
        authRecordExpiresAt: next.authRecordExpiresAt,
      }),
    ).toThrow('UNAUTHORIZED');
  });
});
