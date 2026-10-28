// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { topicRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('topicRouter procedures', () => {
  const procedures = (topicRouter as any)._def.procedures as Record<string, any>;

  it('exposes exactly the expected procedure paths', () => {
    expect(Object.keys(procedures).sort()).toEqual(expected().map(([name]) => name));
  });

  it.each(expected())('%s is a %s with %i middlewares', (name, type, middlewares) => {
    expect(procedures[name]._def.type).toBe(type);
    expect(procedures[name]._def.middlewares).toHaveLength(middlewares);
  });
});

function expected(): Array<
  [name: string, type: 'mutation' | 'query' | 'subscription', middlewares: number]
> {
  return [
    ['batchCreateTopics', 'mutation', 14],
    ['batchDelete', 'mutation', 14],
    ['batchDeleteByAgentId', 'mutation', 14],
    ['batchDeleteByGroupId', 'mutation', 14],
    ['batchDeleteBySessionId', 'mutation', 14],
    ['batchMoveTopics', 'mutation', 14],
    ['branchTopicAtMessage', 'mutation', 14],
    ['cancelRateLimitContinuation', 'mutation', 14],
    ['claimRunningStatus', 'mutation', 14],
    ['cloneTopic', 'mutation', 14],
    ['countTopics', 'query', 13],
    ['createTopic', 'mutation', 14],
    ['disableSharing', 'mutation', 14],
    ['enableSharing', 'mutation', 14],
    ['forkTopic', 'mutation', 14],
    ['getHeteroSessionImportStatus', 'query', 12],
    ['getMaxTaskDuration', 'query', 12],
    ['getShareInfo', 'query', 13],
    ['getTopicContext', 'query', 13],
    ['getTopicDetail', 'query', 13],
    ['getTopicTranscript', 'query', 13],
    ['getTopics', 'query', 13],
    ['hasTopicFiles', 'query', 14],
    ['hasTopics', 'query', 12],
    ['importHeteroSessions', 'mutation', 14],
    ['importTopic', 'mutation', 14],
    ['queryTopics', 'query', 13],
    ['rankTopics', 'query', 13],
    ['recentTopics', 'query', 13],
    ['removeAllTopics', 'mutation', 13],
    ['removeTopic', 'mutation', 14],
    ['searchTopics', 'query', 14],
    ['settleRunningOperation', 'mutation', 14],
    ['updateShareVisibility', 'mutation', 14],
    ['updateTopic', 'mutation', 14],
    ['updateTopicMetadata', 'mutation', 14],
    ['updateTopicModel', 'mutation', 14],
  ];
}
