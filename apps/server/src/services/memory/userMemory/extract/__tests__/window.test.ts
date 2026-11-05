// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { selectExtractionWindow } from '../window';

const NOW = new Date('2026-11-05T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

const message = (id: string, role: 'user' | 'assistant', minutes: number, content = id) => ({
  content,
  createdAt: minutesAgo(minutes),
  id,
  role,
  updatedAt: minutesAgo(minutes),
});

// One token per character keeps the budgets readable.
const options = {
  countTokens: async (text: string) => text.length,
  now: NOW,
  previousRounds: 2,
  previousTokenLimit: 100,
  segmentTokenLimit: 10,
  settleMs: 10 * 60_000,
  trimText: async (text: string, limit: number) => text.slice(0, limit),
};

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe('selectExtractionWindow', () => {
  it('extracts a never-extracted topic from its first message, with no earlier context', async () => {
    const window = await selectExtractionWindow(
      [message('u1', 'user', 60), message('a1', 'assistant', 59)],
      options,
    );

    expect(ids(window.segment)).toEqual(['u1', 'a1']);
    expect(window.previous).toEqual([]);
    expect(window.extractedThrough).toEqual(minutesAgo(59));
    expect(window.hasMore).toBe(false);
  });

  it('extracts only what follows the watermark and carries the last rounds before it as context', async () => {
    const window = await selectExtractionWindow(
      [
        message('u1', 'user', 90),
        message('a1', 'assistant', 89),
        message('u2', 'user', 80),
        message('a2', 'assistant', 79),
        message('u3', 'user', 70),
        message('a3', 'assistant', 69),
        message('u4', 'user', 30),
      ],
      { ...options, watermark: minutesAgo(69) },
    );

    expect(ids(window.segment)).toEqual(['u4']);
    // Two rounds back from the watermark: u2..a3, not u1/a1.
    expect(ids(window.previous)).toEqual(['u2', 'a2', 'u3', 'a3']);
    expect(window.extractedThrough).toEqual(minutesAgo(30));
  });

  it('keeps the earlier context within its own token budget, newest first', async () => {
    const window = await selectExtractionWindow(
      [
        message('u1', 'user', 90, 'x'.repeat(60)),
        message('a1', 'assistant', 89, 'y'.repeat(60)),
        message('u2', 'user', 30),
      ],
      { ...options, watermark: minutesAgo(89) },
    );

    expect(ids(window.previous)).toEqual(['a1']);
  });

  it('cuts a long backlog into segments within the token budget, advancing the watermark each time', async () => {
    const backlog = [
      message('m1', 'user', 60, 'aaaa'),
      message('m2', 'assistant', 59, 'bbbb'),
      message('m3', 'user', 58, 'cccc'),
    ];

    const first = await selectExtractionWindow(backlog, options);
    expect(ids(first.segment)).toEqual(['m1', 'm2']);
    expect(first.extractedThrough).toEqual(minutesAgo(59));
    expect(first.hasMore).toBe(true);

    const second = await selectExtractionWindow(backlog, {
      ...options,
      watermark: first.extractedThrough,
    });
    expect(ids(second.segment)).toEqual(['m3']);
    expect(second.hasMore).toBe(false);
  });

  it('trims a single message larger than the budget rather than stalling on it', async () => {
    const window = await selectExtractionWindow(
      [message('huge', 'user', 60, 'z'.repeat(50)), message('next', 'assistant', 59)],
      options,
    );

    expect(ids(window.segment)).toEqual(['huge']);
    expect(window.segment[0].content).toBe('z'.repeat(10));
    expect(window.extractedThrough).toEqual(minutesAgo(60));
    expect(window.hasMore).toBe(true);
  });

  it('stops before a message that was created or changed too recently to be final', async () => {
    const streaming = { ...message('a2', 'assistant', 20), updatedAt: minutesAgo(1) };
    const window = await selectExtractionWindow(
      [
        message('u1', 'user', 30),
        message('a1', 'assistant', 29),
        message('u2', 'user', 21),
        streaming,
        message('u3', 'user', 2),
      ],
      { ...options, segmentTokenLimit: 100 },
    );

    expect(ids(window.segment)).toEqual(['u1', 'a1', 'u2']);
    expect(window.extractedThrough).toEqual(minutesAgo(21));
    expect(window.hasMore).toBe(false);
  });

  it('has nothing to extract when no settled message follows the watermark', async () => {
    const window = await selectExtractionWindow(
      [message('u1', 'user', 60), message('u2', 'user', 3)],
      { ...options, watermark: minutesAgo(60) },
    );

    expect(window.segment).toEqual([]);
    expect(window.extractedThrough).toBeUndefined();
    expect(window.hasMore).toBe(false);
  });
});
