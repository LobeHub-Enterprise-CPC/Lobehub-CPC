import type { UIChatMessage } from '@lobechat/types';

const withoutUsageMetrics = (data: object) =>
  Object.fromEntries(
    Object.entries(data).filter(
      ([key]) =>
        !/tokens(?:_?details)?$|^(?:tps|inputCacheRate|cacheHitRate|tokensPerSecond)$/i.test(key),
    ),
  );

export const stripMemberTokenUsage = (metadata: UIChatMessage['metadata']) => {
  if (!metadata) return metadata;

  return {
    ...withoutUsageMetrics(metadata),
    ...(metadata.usage && { usage: withoutUsageMetrics(metadata.usage) }),
    ...(metadata.performance && { performance: withoutUsageMetrics(metadata.performance) }),
  };
};
