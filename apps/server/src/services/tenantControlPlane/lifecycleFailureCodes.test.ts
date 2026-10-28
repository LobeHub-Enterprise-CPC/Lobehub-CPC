import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { LIFECYCLE_FAILURE_CODES, SAFE_ERROR_CODES } from './contracts';

const contract = JSON.parse(
  readFileSync(
    new URL(
      './../../../../../contracts/tenant-control-plane/lifecycle-failure-codes.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { codes: Record<string, { disposition: string; producers: string[] }> };

describe('lifecycle failure codes contract', () => {
  it('returns exactly the codes the shared contract assigns to LobeHub, with the same disposition', () => {
    const expected = Object.fromEntries(
      Object.entries(contract.codes)
        .filter(([, entry]) => entry.producers.includes('lobehub'))
        .map(([code, entry]) => [code, entry.disposition]),
    );
    expect(LIFECYCLE_FAILURE_CODES).toEqual(expected);
  });

  it('lets every LobeHub lifecycle code through its own safe-code filter', () => {
    const safe = new Set<string>(SAFE_ERROR_CODES);
    expect(Object.keys(LIFECYCLE_FAILURE_CODES).filter((code) => !safe.has(code))).toEqual([]);
  });
});
