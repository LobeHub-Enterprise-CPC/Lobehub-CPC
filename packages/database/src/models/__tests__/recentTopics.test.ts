// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '../../core/getTestDB';
import { agents, projects, topics, users, workspaces } from '../../schemas';
import type { LobeChatDatabase } from '../../type';
import { RecentModel } from '../recent';

const serverDB: LobeChatDatabase = await getTestDB();

const userId = 'recent-topics-test-user';
const otherUserId = 'recent-topics-test-other-user';

const recentModel = new RecentModel(serverDB, userId);

const now = () => new Date();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000);

beforeEach(async () => {
  await serverDB.delete(users);
  await serverDB.insert(users).values([{ id: userId }, { id: otherUserId }]);
});

afterEach(async () => {
  await serverDB.delete(users);
});

describe('queryRecentTopics', () => {
  const seedProject = async (id: string, identifier: string, isDeleted?: boolean) => {
    await serverDB.insert(agents).values({ id: `${id}-coordinator`, userId, virtual: true });
    await serverDB.insert(projects).values({
      coordinatorAgentId: `${id}-coordinator`,
      id,
      identifier,
      isDeleted,
      name: id,
      userId,
    });
  };

  beforeEach(async () => {
    await serverDB.insert(agents).values({ id: 'agent-mine', slug: 'inbox', userId });
  });

  it('lists conversations outside projects, newest first, running and unread included', async () => {
    await seedProject('project-live', 'P0001');
    await serverDB.insert(topics).values([
      { agentId: 'agent-mine', id: 'topic-plain', updatedAt: minutesAgo(3), userId },
      {
        agentId: 'agent-mine',
        id: 'topic-running',
        status: 'running',
        updatedAt: minutesAgo(1),
        userId,
      },
      {
        agentId: 'agent-mine',
        id: 'topic-unread',
        status: 'unread',
        updatedAt: minutesAgo(2),
        userId,
      },
      {
        agentId: 'agent-mine',
        id: 'topic-in-project',
        projectId: 'project-live',
        updatedAt: now(),
        userId,
      },
      {
        agentId: 'agent-mine',
        id: 'topic-cron',
        trigger: 'cron',
        updatedAt: now(),
        userId,
      },
    ]);

    const result = await recentModel.queryRecentTopics();

    expect(result.map((r) => r.id)).toEqual(['topic-running', 'topic-unread', 'topic-plain']);
    expect(result[0]).toMatchObject({
      routeId: 'agent-mine',
      title: 'Untitled Topic',
      type: 'topic',
    });
  });

  it('brings back conversations of a project in the recycle bin', async () => {
    await seedProject('project-trashed', 'P0002', true);
    await serverDB.insert(topics).values({
      agentId: 'agent-mine',
      id: 'topic-trashed-project',
      projectId: 'project-trashed',
      userId,
    });

    const result = await recentModel.queryRecentTopics();

    expect(result.map((r) => r.id)).toEqual(['topic-trashed-project']);
  });

  it('applies the limit', async () => {
    await serverDB.insert(topics).values(
      [1, 2, 3].map((n) => ({
        agentId: 'agent-mine',
        id: `topic-${n}`,
        updatedAt: minutesAgo(n),
        userId,
      })),
    );

    const result = await recentModel.queryRecentTopics(2);

    expect(result.map((r) => r.id)).toEqual(['topic-1', 'topic-2']);
  });

  it("keeps a workspace feed to the viewer's own conversations", async () => {
    const workspaceId = 'recent-topics-test-workspace';
    await serverDB
      .insert(workspaces)
      .values({ id: workspaceId, name: 'ws', primaryOwnerId: userId, slug: workspaceId });
    await serverDB.insert(agents).values({ id: 'agent-ws', slug: 'inbox', userId, workspaceId });
    await serverDB.insert(topics).values([
      { agentId: 'agent-ws', id: 'topic-ws-mine', userId, workspaceId },
      { agentId: 'agent-ws', id: 'topic-ws-other', userId: otherUserId, workspaceId },
    ]);

    const result = await new RecentModel(serverDB, userId, workspaceId).queryRecentTopics();

    expect(result.map((r) => r.id)).toEqual(['topic-ws-mine']);
  });
});
