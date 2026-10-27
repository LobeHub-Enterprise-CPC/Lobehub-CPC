/** Reused conversations have one task_topics row; count later ticks separately.
 * The counter belongs to the current armed schedule window, never to manual runs.
 */
export const reusedScheduleExecutions = (context: unknown): number => {
  const scheduler = (
    context as {
      scheduler?: {
        scheduleStartedAt?: string;
        reusedExecutions?: { window?: string; count?: number };
      };
    } | null
  )?.scheduler;
  const reused = scheduler?.reusedExecutions;
  return scheduler?.scheduleStartedAt &&
    reused?.window === scheduler.scheduleStartedAt &&
    typeof reused.count === 'number' &&
    Number.isSafeInteger(reused.count) &&
    reused.count > 0
    ? reused.count
    : 0;
};
