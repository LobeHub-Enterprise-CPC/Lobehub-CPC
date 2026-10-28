import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { discoveryAdmission } from './admission';
import { hasOtherOrganizations } from './otherOrganizations';

const deps = vi.hoisted(() => ({
  candidates: vi.fn(),
  config: vi.fn(),
  lookup: vi.fn(),
  query: vi.fn(),
}));
vi.mock('@lobechat/env/tenantDiscovery', () => ({ getTenantDiscoveryConfig: deps.config }));
vi.mock('./candidates', () => ({ loadDiscoveryCandidates: deps.candidates }));
vi.mock('./connection', () => ({ withLookupClient: deps.lookup }));
vi.mock('./query', async (original) => ({
  ...(await original<object>()),
  queryTenantMembership: deps.query,
}));

/** Settles with `'slow'` if `promise` does not settle quickly (the budget itself is a second). */
const promptly = <T>(promise: Promise<T>) =>
  Promise.race([promise, new Promise<'slow'>((resolve) => setTimeout(() => resolve('slow'), 200))]);

const tenant = (id: string) => ({ id, name: id, schemaName: `schema_${id}` });

beforeEach(() => {
  vi.clearAllMocks();
  deps.config.mockReturnValue({ ACCOUNT_LOOKUP_DATABASE_URL: 'postgres://lookup@db/lobe' });
  deps.candidates.mockResolvedValue([tenant('current'), tenant('other')]);
  deps.lookup.mockImplementation(async (_signal, work) => work({}));
  deps.query.mockImplementation(async (_client, candidates) => candidates);
});
afterEach(() => vi.useRealTimers());

describe('hasOtherOrganizations', () => {
  it('is true when the email is a member of another organization', async () => {
    expect(await hasOtherOrganizations('a@example.com', 'current')).toBe(true);
  });

  it('is false when the current organization is the only one', async () => {
    deps.query.mockImplementation(async (_client, candidates) => candidates);
    deps.candidates.mockResolvedValue([tenant('current')]);

    expect(await hasOtherOrganizations('a@example.com', 'current')).toBe(false);
  });

  it('never counts the current organization', async () => {
    // Even a lookup that reports the current tenant must not make the answer true.
    deps.query.mockResolvedValue([tenant('current')]);

    expect(await hasOtherOrganizations('a@example.com', 'current')).toBe(false);
  });

  it('looks up with the discovery rules: normalized email, lookup role, shared admission', async () => {
    const admission = vi.spyOn(discoveryAdmission, 'tryRun');

    await hasOtherOrganizations(' A@EXAMPLE.COM ', 'current');

    expect(admission).toHaveBeenCalledTimes(1);
    expect(deps.candidates).toHaveBeenCalledTimes(1);
    expect(deps.lookup).toHaveBeenCalledTimes(1);
    expect(deps.query.mock.lastCall?.[2]).toBe('a@example.com');
  });

  it.each([
    ['the candidate set is incomplete', () => deps.candidates.mockRejectedValue(new Error('503'))],
    ['the membership query fails', () => deps.query.mockRejectedValue(new Error('pg down'))],
    ['the lookup connection fails', () => deps.lookup.mockRejectedValue(new Error('refused'))],
  ])('is unknown when %s', async (_name, arrange) => {
    arrange();

    expect(await hasOtherOrganizations('a@example.com', 'current')).toBeUndefined();
  });

  it('is unknown, without touching any database, when the lookup role is not configured', async () => {
    deps.config.mockReturnValue({});

    expect(await hasOtherOrganizations('a@example.com', 'current')).toBeUndefined();
    expect(deps.candidates).not.toHaveBeenCalled();
    expect(deps.lookup).not.toHaveBeenCalled();
  });

  it('is unknown without an email', async () => {
    expect(await hasOtherOrganizations('  ', 'current')).toBeUndefined();
    expect(await hasOtherOrganizations(null, 'current')).toBeUndefined();
    expect(deps.candidates).not.toHaveBeenCalled();
  });

  it('does not queue behind a busy gate: it answers unknown at once', async () => {
    const released = Promise.withResolvers<void>();
    const busy = Array.from({ length: 4 }, () =>
      discoveryAdmission.run(new AbortController().signal, () => released.promise),
    );

    expect(await promptly(hasOtherOrganizations('a@example.com', 'current'))).toBeUndefined();
    expect(deps.candidates).not.toHaveBeenCalled();

    released.resolve();
    await Promise.all(busy);
    expect(await hasOtherOrganizations('a@example.com', 'current')).toBe(true);
  });

  it('stops its database work when the caller gives up', async () => {
    const caller = new AbortController();
    let workSignal: AbortSignal | undefined;
    deps.candidates.mockImplementation((signal: AbortSignal) => {
      workSignal = signal;
      return new Promise(() => {});
    });

    const result = hasOtherOrganizations('a@example.com', 'current', { signal: caller.signal });
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    caller.abort();

    expect(await promptly(result)).toBeUndefined();
    expect(workSignal?.aborted).toBe(true);
  });

  it('gives up after about a second', async () => {
    vi.useFakeTimers();
    deps.candidates.mockReturnValue(new Promise(() => {}));

    const result = hasOtherOrganizations('a@example.com', 'current');
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);

    expect(await result).toBeUndefined();
  });

  it('does not log the email', async () => {
    const spies = (['error', 'warn', 'log'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    deps.query.mockRejectedValue(new Error('failed for secret@example.com'));

    await hasOtherOrganizations('secret@example.com', 'current');

    for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain('secret@');
    for (const spy of spies) spy.mockRestore();
  });
});
