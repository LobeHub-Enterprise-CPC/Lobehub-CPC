// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { fitBodyToQuota } from './fitBody';

const quota = {
  budgetBytes: 9 * 1024 * 1024,
  limitBytes: 10 * 1024 * 1024,
  measure: (body: unknown) => Buffer.byteLength(JSON.stringify(body), 'utf8'),
  transport: 'test',
};

describe('fitBodyToQuota', () => {
  it('leaves a body under budget untouched', () => {
    const request = { body: { text: 'small' } };
    expect(fitBodyToQuota(request, 'op', quota)).toBe(request);
  });

  /**
   * Fragmented oversize: the MCP contract keeps every raw content block in
   * `state`, so a body can pass the quota through hundreds of mid-sized
   * strings that a single generous clamp pass would leave untouched.
   */
  it('tightens the clamp until a fragmented oversized body actually fits', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocks = Array.from({ length: 525 }, () => ({ text: 'y'.repeat(20_000) }));

    const { body } = fitBodyToQuota({ body: { state: { content: blocks } } }, 'op', quota);

    expect(quota.measure(body)).toBeLessThan(quota.budgetBytes);
    const content = (body as { state: { content: { text: string }[] } }).state.content;
    expect(content).toHaveLength(525);
    expect(content[0].text).toContain('characters omitted so the step could be scheduled');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"stringKeep":4000'));
    warn.mockRestore();
  });

  it('fails with a diagnosable error when no string clamp can fit the body', () => {
    const body = { items: Array.from({ length: 10 }, (_, i) => i) };
    expect(() => fitBodyToQuota({ body }, 'op-x', { ...quota, budgetBytes: 4 })).toThrow(
      'test message for operation op-x',
    );
  });
});
