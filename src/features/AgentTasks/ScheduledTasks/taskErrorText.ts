import { getErrorCodeSpec } from '@lobechat/model-runtime/errors';
import { AgentRuntimeErrorType } from '@lobechat/types';

import { getRuntimeErrorMessage } from '@/utils/locale/runtimeErrorMessage';

/**
 * The error type whose localized copy replaces a task's stored `error` text.
 *
 * Only our own (harness) failures: their stored text is a generic English line
 * or an internal message, and their copy takes no variables. A provider or user
 * failure keeps the provider's own text, which says more than the generic copy.
 * PostgreSQL buckets (`pg_<sqlstate>`) read as the database failure they are.
 */
const localizedTaskErrorType = (errorType: string | undefined): string | undefined => {
  if (!errorType) return undefined;
  if (errorType.startsWith('pg_')) return AgentRuntimeErrorType.DatabasePersistError;
  return getErrorCodeSpec(errorType)?.attribution === 'harness' ? errorType : undefined;
};

/** The text a task's failure alert shows; `t` needs the `error` and `modelRuntime` namespaces. */
export const getTaskErrorText = (
  t: unknown,
  error: string,
  errorType: string | undefined,
): string => {
  const type = localizedTaskErrorType(errorType);
  return type ? getRuntimeErrorMessage(t, type, undefined, error) : error;
};
