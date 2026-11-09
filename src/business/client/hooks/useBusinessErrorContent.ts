import type { ChatMessageError } from '@lobechat/types';
import { AgentRuntimeErrorType } from '@lobechat/types';
import { useTranslation } from 'react-i18next';

export interface BusinessErrorContentResult {
  errorType?: string;
  hideMessage?: boolean;
  message?: string;
}

/**
 * `budget.budgetTypeAtError` the enterprise spend gate attaches when a member's own model usage
 * budget (personal, or allotted through a department) is used up. Without it the member got the
 * generic `InsufficientQuota` copy about an API key's quota, which they can't act on.
 */
export const MEMBER_BUDGET_TYPE = 'organization_member';

const isMemberBudgetExceeded = (error?: ChatMessageError | null) =>
  error?.type === AgentRuntimeErrorType.InsufficientQuota &&
  (error.body as { budget?: { budgetTypeAtError?: unknown } } | undefined)?.budget
    ?.budgetTypeAtError === MEMBER_BUDGET_TYPE;

export default function useBusinessErrorContent(
  error?: ChatMessageError | null,
): BusinessErrorContentResult {
  const { t } = useTranslation('error');

  if (isMemberBudgetExceeded(error)) return { message: t('memberBudgetExceeded') };

  return {};
}
