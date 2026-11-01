'use client';

import { Center, Spin, Text } from '@lobehub/ui';
import { type ReactElement, useCallback, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import AsyncError from '@/components/AsyncError';
import { useInitAgentConfig } from '@/hooks/useInitAgentConfig';
import { useAgentStore } from '@/store/agent';
import { useChatStore } from '@/store/chat';
import { topicSelectors } from '@/store/chat/selectors';
import { useCurrentProjectDetail, useProjectStore } from '@/store/project';
import { useProjectDirectoryStore, useProjectTopics } from '@/store/projectWorkingDirectory';

import { getProjectConversationPath } from '../Layout/navigation';

/**
 * Route, store and agent wiring for a project conversation, shared by the
 * desktop workspace and the mobile page. `fallback` is set until the pane can
 * render at all (error, redirect, not-found or loading).
 */
export const useProjectConversation = () => {
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

  let fallback: ReactElement | undefined;
  if (topicDetail.error)
    fallback = (
      <AsyncError error={topicDetail.error} variant="page" onRetry={topicDetail.revalidate} />
    );
  else if (agent.error)
    fallback = <AsyncError error={agent.error} variant="page" onRetry={agent.mutate} />;
  else if (topicsRequest.error)
    fallback = (
      <AsyncError error={topicsRequest.error} variant="page" onRetry={topicsRequest.revalidate} />
    );
  // New project conversations start from the project home composer.
  else if (!topicId) fallback = <Navigate replace relative="path" to=".." />;
  else if (topicsRequest.hasData && !selectedTopic)
    fallback = (
      <Center height="100%">
        <Text>{t('topics.notFound')}</Text>
      </Center>
    );
  else if (detailSWR.error && !detail)
    fallback = <AsyncError error={detailSWR.error} variant="page" onRetry={detailSWR.revalidate} />;
  else if (
    !detail ||
    !conversationAgentId ||
    agent.isLoading ||
    (!storedTopic && topicDetail.isValidating) ||
    activeAgentId !== conversationAgentId
  )
    fallback = (
      <Center height="100%" width="100%">
        <Spin size="small" />
      </Center>
    );

  return {
    fallback,
    getConversationPath,
    getTopicPath,
    title: topicTitle || selectedTopic?.title || t('sidebar.newConversation'),
    topic: topicId
      ? {
          id: topicId,
          status: selectedTopic?.status,
          title: topicTitle || selectedTopic?.title || t('directories.untitled'),
        }
      : undefined,
  };
};
