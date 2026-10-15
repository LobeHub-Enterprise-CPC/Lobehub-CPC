import { INLINE_VIDEO_SIZE_LIMIT } from '@lobechat/const/media';
import { createMediaFileRef } from '@lobechat/const/mediaRef';

const formatMebibytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Stands in for a video too large to inline. Names both sizes so the model can
 * say why the video is not attached, and carries the media ref `filesPrompts`
 * emits for the same attachment so the media-analysis tool resolves it to the
 * same file.
 */
export const videoInlineLimitPlaceholder = ({
  index,
  limit,
  messageId,
  size,
}: {
  index: number;
  limit: number;
  messageId?: string;
  size: number;
}) => {
  const ref = createMediaFileRef({ index, messageId, type: 'video' });

  return `[video omitted: ${formatMebibytes(size)} exceeds the ${formatMebibytes(limit)} this provider accepts inline. Media ref: ${ref}. Do not infer or describe the video. Use an available media-analysis tool with this ref before answering.]`;
};

export interface VideoInlineLimitInput {
  /** Whether the target model accepts inline video at all. */
  canUseVideo: boolean;
  /** Deployment override for the provider's inline ceiling. */
  limit?: number;
  messageId?: string;
  /** Text content already assembled for this message. */
  textContent: string;
  videoList: any[];
}

export interface VideoInlineLimitResult {
  /** Indexes the caller must drop from its inline video list. */
  oversizedVideoIndexes: Set<number>;
  /** `textContent` with one placeholder per oversized video appended. */
  textContent: string;
}

/**
 * An inlined video is a URL the provider fetches for itself, and it measures
 * what it fetched against its own ceiling before running any inference.
 * Sending one that is over that ceiling does not just fail this turn: the
 * attachment stays in the conversation history, so every later turn carries
 * it and fails identically, whatever the user sends next. The topic is dead
 * from the moment the file enters it.
 *
 * Hand the oversized ones to the media-analysis tool instead — the same
 * escape hatch an image takes when the model has no native vision. That path
 * fetches the file on its own terms and is not bound by the inline limit.
 */
export const applyVideoInlineLimit = ({
  canUseVideo,
  limit,
  messageId,
  textContent,
  videoList,
}: VideoInlineLimitInput): VideoInlineLimitResult => {
  const inlineVideoLimit = limit ?? INLINE_VIDEO_SIZE_LIMIT;
  const oversizedVideoIndexes = new Set<number>(
    canUseVideo
      ? videoList.flatMap((video, index) =>
          typeof video?.size === 'number' && video.size > inlineVideoLimit ? [index] : [],
        )
      : [],
  );

  if (oversizedVideoIndexes.size === 0) return { oversizedVideoIndexes, textContent };

  const placeholders = [...oversizedVideoIndexes]
    .map((index) =>
      videoInlineLimitPlaceholder({
        index,
        limit: inlineVideoLimit,
        messageId,
        size: videoList[index].size,
      }),
    )
    .join('\n');

  return {
    oversizedVideoIndexes,
    textContent: textContent ? `${textContent}\n\n${placeholders}` : placeholders,
  };
};
