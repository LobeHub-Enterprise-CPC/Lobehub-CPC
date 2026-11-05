/**
 * Starting values for incremental chat-topic extraction, to be tuned against production runs.
 *
 * - `previousRounds` / `previousTokenLimit`: conversation before the watermark sent as context
 *   only (references, ongoing threads), whichever bound is hit first.
 * - `segmentTokenLimit`: new conversation sent per extraction when no extractor context limit
 *   is configured; a longer backlog is extracted segment by segment.
 * - `settleMs`: a message created or changed this recently may still be streaming and waits.
 */
export const MEMORY_EXTRACTION_WINDOW = {
  previousRounds: 3,
  previousTokenLimit: 2000,
  segmentTokenLimit: 32_000,
  settleMs: 10 * 60_000,
} as const;

export interface ExtractionWindowMessage {
  content: string;
  createdAt: Date;
  id: string;
  role: string;
  updatedAt?: Date | null;
}

export interface ExtractionWindowOptions {
  countTokens: (text: string) => Promise<number>;
  now: Date;
  previousRounds: number;
  previousTokenLimit: number;
  segmentTokenLimit: number;
  settleMs: number;
  trimText: (text: string, tokenLimit: number) => Promise<string>;
  /** Creation time of the last message already extracted; absent for a topic never extracted. */
  watermark?: Date;
}

export interface ExtractionWindow<T extends ExtractionWindowMessage> {
  /** Where the watermark moves once `segment` is extracted; absent when there is nothing to do. */
  extractedThrough?: Date;
  /** More settled messages follow `segment`. */
  hasMore: boolean;
  /** Last messages before the watermark, oldest first: context, not to be extracted again. */
  previous: T[];
  /** Messages to extract now, oldest first. */
  segment: T[];
}

/**
 * Picks what one extraction run of a topic reads: the settled conversation after the watermark,
 * cut to the segment budget from its oldest message, plus a few rounds before the watermark as
 * context.
 *
 * Expects `messages` to be the topic's conversation (user and assistant turns) ordered by
 * creation time.
 */
export const selectExtractionWindow = async <T extends ExtractionWindowMessage>(
  messages: T[],
  options: ExtractionWindowOptions,
): Promise<ExtractionWindow<T>> => {
  const { watermark } = options;
  const settledBefore = options.now.getTime() - options.settleMs;
  const isAfterWatermark = (item: T) => !watermark || item.createdAt > watermark;

  const pending: T[] = [];
  for (const item of messages) {
    if (!isAfterWatermark(item)) continue;
    const changedAt = Math.max(item.createdAt.getTime(), item.updatedAt?.getTime() ?? 0);
    // A message still being written ends the settled part: nothing after it may jump ahead.
    if (changedAt >= settledBefore) break;
    pending.push(item);
  }

  const segment: T[] = [];
  let used = 0;
  for (const item of pending) {
    const tokens = await options.countTokens(item.content);
    if (segment.length === 0 && tokens > options.segmentTokenLimit) {
      segment.push({
        ...item,
        content: await options.trimText(item.content, options.segmentTokenLimit),
      });
      break;
    }
    if (used + tokens > options.segmentTokenLimit) break;
    segment.push(item);
    used += tokens;
  }

  return {
    extractedThrough: segment.at(-1)?.createdAt,
    hasMore: segment.length < pending.length,
    previous: watermark && segment.length > 0 ? await selectPrevious(messages, options) : [],
    segment,
  };
};

const selectPrevious = async <T extends ExtractionWindowMessage>(
  messages: T[],
  options: ExtractionWindowOptions,
): Promise<T[]> => {
  const before = messages.filter(
    (item) => options.watermark && item.createdAt <= options.watermark,
  );
  const previous: T[] = [];
  let rounds = 0;
  let used = 0;
  for (let index = before.length - 1; index >= 0; index -= 1) {
    const item = before[index];
    const tokens = await options.countTokens(item.content);
    if (used + tokens > options.previousTokenLimit) break;
    previous.unshift(item);
    used += tokens;
    // A round starts at a user turn; stop once enough of them are in.
    if (item.role === 'user' && ++rounds >= options.previousRounds) break;
  }
  return previous;
};
