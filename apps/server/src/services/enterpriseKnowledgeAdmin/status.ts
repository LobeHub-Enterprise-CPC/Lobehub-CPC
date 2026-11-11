import { AsyncTaskErrorType, AsyncTaskStatus } from '@lobechat/types';

export type TaskState = 'error' | 'pending' | 'processing' | 'success' | null;
export type ContentStatus = 'embedding' | 'error' | 'none' | 'parsing' | 'pending' | 'success';
export type StatusStage = 'embedding' | 'parsing' | null;

export const toTaskState = (status: string | null | undefined): TaskState =>
  status === AsyncTaskStatus.Pending ||
  status === AsyncTaskStatus.Processing ||
  status === AsyncTaskStatus.Success ||
  status === AsyncTaskStatus.Error
    ? status
    : null;

/**
 * Folds the parsing (chunk) task and the embedding task of one file into the one status a
 * member sees. A parsing failure wins over an embedding one: the file has nothing to embed.
 */
export const deriveStatus = (
  chunk: TaskState,
  embedding: TaskState,
): { stage: StatusStage; status: ContentStatus } => {
  if (chunk === 'error') return { stage: 'parsing', status: 'error' };
  if (embedding === 'error') return { stage: 'embedding', status: 'error' };

  if (chunk === 'pending') return { stage: null, status: 'pending' };
  if (chunk === 'processing') return { stage: 'parsing', status: 'parsing' };

  if (chunk === 'success') {
    return embedding === 'success'
      ? { stage: null, status: 'success' }
      : { stage: 'embedding', status: 'embedding' };
  }

  if (embedding === null) return { stage: null, status: 'none' };
  return embedding === 'success'
    ? { stage: null, status: 'success' }
    : { stage: 'embedding', status: 'embedding' };
};

/** Whether the file is still waiting for, or inside, parsing or embedding. */
export const isProcessingStatus = (status: ContentStatus) =>
  status === 'pending' || status === 'parsing' || status === 'embedding';

const ERROR_MESSAGES: Record<string, string> = {
  [AsyncTaskErrorType.EmbeddingError]: '文件向量化失败，请重试。',
  [AsyncTaskErrorType.FileTooLargeToParse]: '文件过大，无法解析。',
  [AsyncTaskErrorType.InvalidProviderAPIKey]: '向量化服务暂不可用，请联系管理员。',
  [AsyncTaskErrorType.ModelNotFound]: '向量化服务暂不可用，请联系管理员。',
  [AsyncTaskErrorType.NoChunkError]: '没有从文件中解析出可检索的内容。',
  [AsyncTaskErrorType.ProviderContentModeration]: '文件内容未通过内容审核。',
  [AsyncTaskErrorType.SubscriptionPlanLimit]: '向量化额度不足，请联系管理员。',
  [AsyncTaskErrorType.TaskCancelled]: '处理已取消，请重试。',
  [AsyncTaskErrorType.TaskTriggerError]: '处理任务没有成功启动，请重试。',
  [AsyncTaskErrorType.Timeout]: '处理超时，请重试。',
};

/**
 * One plain sentence for a failed task. The stored error carries stack traces, SQL and
 * upstream text, none of which a member should see, so only the error name is consulted.
 */
export const describeTaskError = (
  stage: StatusStage,
  error: { name?: unknown } | null | undefined,
): string => {
  const name = typeof error?.name === 'string' ? error.name : undefined;
  if (name && ERROR_MESSAGES[name]) return ERROR_MESSAGES[name];

  return stage === 'embedding' ? '文件向量化失败，请重试。' : '文件解析失败，请重试。';
};
