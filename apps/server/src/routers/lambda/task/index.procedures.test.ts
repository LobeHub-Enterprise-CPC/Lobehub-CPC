// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { taskRouter } from '.';

/**
 * Pins the router's public surface: every procedure path, its kind, and its
 * middleware chain length (which encodes the procedure builder and its input
 * parsers). Splitting the router across files must keep all three.
 */
describe('taskRouter procedures', () => {
  const procedures = (taskRouter as any)._def.procedures as Record<string, any>;

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
    ['acquireTaskLock', 'mutation', 14],
    ['addComment', 'mutation', 14],
    ['addDependency', 'mutation', 14],
    ['analyzeIntent', 'mutation', 14],
    ['archive', 'mutation', 14],
    ['cancelTopic', 'mutation', 14],
    ['clearAll', 'mutation', 13],
    ['copyTaskToWorkspace', 'mutation', 14],
    ['create', 'mutation', 14],
    ['delete', 'mutation', 14],
    ['deleteComment', 'mutation', 14],
    ['deleteTopic', 'mutation', 14],
    ['detail', 'query', 13],
    ['find', 'query', 13],
    ['getCheckpoint', 'query', 13],
    ['getDependencies', 'query', 13],
    ['getPinnedDocuments', 'query', 13],
    ['getReview', 'query', 13],
    ['getSubtasks', 'query', 13],
    ['getTaskLock', 'query', 14],
    ['getTaskTree', 'query', 13],
    ['getTopics', 'query', 13],
    ['getVerifyConfig', 'query', 13],
    ['groupList', 'query', 13],
    ['heartbeat', 'mutation', 14],
    ['list', 'query', 13],
    ['pinDocument', 'mutation', 14],
    ['previewSubtaskLayers', 'query', 13],
    ['releaseTaskLock', 'mutation', 14],
    ['removeDependency', 'mutation', 14],
    ['reorderSubtasks', 'mutation', 14],
    ['run', 'mutation', 14],
    ['runReadySubtasks', 'mutation', 14],
    ['runReview', 'mutation', 14],
    ['synthesizeInstruction', 'mutation', 14],
    ['transferTask', 'mutation', 14],
    ['unpinDocument', 'mutation', 14],
    ['update', 'mutation', 14],
    ['updateCheckpoint', 'mutation', 14],
    ['updateComment', 'mutation', 14],
    ['updateConfig', 'mutation', 14],
    ['updateReview', 'mutation', 14],
    ['updateStatus', 'mutation', 14],
    ['updateStatusCascade', 'mutation', 14],
    ['updateVerifyConfig', 'mutation', 14],
    ['updateVisibility', 'mutation', 14],
    ['usage', 'query', 13],
    ['watchdog', 'mutation', 13],
  ];
}
