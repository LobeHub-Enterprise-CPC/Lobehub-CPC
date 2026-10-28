'use client';

import { Center, Flexbox, Spin, Text } from '@lobehub/ui';
import { cssVar } from '@lobehub/ui/stylex/cssVar.stylex';
import * as stylex from '@stylexjs/stylex';
import { memo, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import TopicActions from '@/features/AgentSidebar/Topic/List/Item/Actions';
import ConversationWorkspace from '@/features/Conversation/Workspace';
import NavHeader from '@/features/NavHeader';
import { useInitAgentConfig } from '@/hooks/useInitAgentConfig';
import ChatConversation from '@/routes/(main)/agent/features/Conversation';
import ChatHydration from '@/routes/(main)/agent/features/Conversation/ChatHydration';
import { conversationHeaderStyles } from '@/routes/(main)/agent/features/Conversation/Header';
import TerminalPanelToggle from '@/routes/(main)/agent/features/Conversation/Header/TerminalPanelToggle';
import WorkingPanelToggle from '@/routes/(main)/agent/features/Conversation/Header/WorkingPanelToggle';
import { useAgentStore } from '@/store/agent';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { useCurrentProjectDetail, useProjectStore } from '@/store/project';
import { useProjectDirectoryStore, useProjectTopics } from '@/store/projectWorkingDirectory';

import { getProjectConversationPath } from '../Layout/navigation';

// The agent conversation page's layout paints the column with the container
// background; this page has no such layout around it.
const styles = stylex.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: cssVar.colorBgContainer,
  },
});

const ProjectConversation = memo(() => {
  const { t } = useTranslation('project');
  const { projectId, topicId } = useParams<{ projectId: string; topicId?: string }>();
  const detail = useCurrentProjectDetail(projectId);
  const detailSWR = useProjectStore((s) => s.useFetchProjectDetail)(projectId);
  const topicsRequest = useProjectDirectoryStore((s) => s.useFetchProjectTopics)(
    detail?.project.id,
  );
  const topics = useProjectTopics(detail?.project.id);
  const selectedTopic = topics.find((topic) => topic.id === topicId);
  const conversationAgentId = topicId
    ? (selectedTopic?.agentId ?? undefined)
    : detail?.project.coordinatorAgentId;
  const projectSlug = detail?.project.slug ?? projectId;
  const storedTopic = useChatStore((s) =>
    topicId ? topicSelectors.getTopicById(topicId)(s) : undefined,
  );
  const topicTitle = storedTopic?.title;

  const agent = useInitAgentConfig(conversationAgentId);
  const topicDetail = useChatStore((s) => s.useFetchTopicDetail)(selectedTopic?.id);
  const activeAgentId = useChatStore((s) => s.activeAgentId);

  useLayoutEffect(() => {
    if (!conversationAgentId) return;

    useAgentStore.setState(
      { activeAgentId: conversationAgentId },
      false,
      'ProjectConversation/syncAgentId',
    );
    useChatStore.setState(
      { activeAgentId: conversationAgentId },
      false,
      'ProjectConversation/syncAgentId',
    );
  }, [conversationAgentId]);

  const getConversationPath = useCallback(
    () => getProjectConversationPath(projectSlug!),
    [projectSlug],
  );
  const getTopicPath = useCallback(
    (_agentId: string, topicId: string) => getProjectConversationPath(projectSlug!, topicId),
    [projectSlug],
  );

  if (topicDetail.error)
    return <AsyncError error={topicDetail.error} variant="page" onRetry={topicDetail.revalidate} />;
  if (agent.error) return <AsyncError error={agent.error} variant="page" onRetry={agent.mutate} />;
  if (topicsRequest.error)
    return (
      <AsyncError error={topicsRequest.error} variant="page" onRetry={topicsRequest.revalidate} />
    );
  // New project conversations start from the project home composer.
  if (!topicId) return <Navigate replace relative="path" to=".." />;
  if (topicsRequest.hasData && !selectedTopic)
    return (
      <Center height="100%">
        <Text>{t('topics.notFound')}</Text>
      </Center>
    );
  if (detailSWR.error && !detail) {
    return <AsyncError error={detailSWR.error} variant="page" onRetry={detailSWR.revalidate} />;
  }
  if (
    !detail ||
    !conversationAgentId ||
    agent.isLoading ||
    (!storedTopic && topicDetail.isValidating) ||
    activeAgentId !== conversationAgentId
  ) {
    return (
      <Center height="100%" width="100%">
        <Spin size="small" />
      </Center>
    );
  }

  return (
    <Flexbox className={stylex.props(styles.container).className} flex={1} height={'100%'}>
      <ConversationWorkspace
        header={
          // The agent conversation header's frame, so the title, its "..." and
          // the message stream below sit where they do in an agent conversation.
          <div
            className={conversationHeaderStyles.container}
            data-brand-slot={'conversation-header'}
          >
            <NavHeader
              left={
                <Flexbox
                  allowShrink
                  horizontal
                  align="center"
                  className={conversationHeaderStyles.leftContent}
                  gap={4}
                >
                  <Text ellipsis style={{ marginInlineStart: 8 }} weight={600}>
                    {topicTitle || selectedTopic?.title || t('sidebar.newConversation')}
                  </Text>
                  <TopicActions
                    id={topicId}
                    status={selectedTopic?.status}
                    title={topicTitle || selectedTopic?.title || t('directories.untitled')}
                    completionLabel={t(
                      selectedTopic?.status === 'completed' ? 'topics.resume' : 'topics.complete',
                    )}
                  />
                </Flexbox>
              }
              right={
                <Flexbox
                  horizontal
                  align="center"
                  className={conversationHeaderStyles.rightContent}
                  gap={4}
                >
                  <TerminalPanelToggle />
                  <WorkingPanelToggle />
                </Flexbox>
              }
              slotClassNames={{
                left: conversationHeaderStyles.slotLeft,
                right: conversationHeaderStyles.slotRight,
              }}
            />
          </div>
        }
      >
        <ChatHydration getConversationPath={getConversationPath} getTopicPath={getTopicPath} />
        <ChatConversation />
      </ConversationWorkspace>
    </Flexbox>
  );
});

ProjectConversation.displayName = 'ProjectConversation';

export default ProjectConversation;
