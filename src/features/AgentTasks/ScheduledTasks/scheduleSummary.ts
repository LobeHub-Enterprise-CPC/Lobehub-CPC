import { validateCronPattern } from '@lobechat/utils/cronEval';
import dayjs from 'dayjs';
import type { TFunction } from 'i18next';

import { WEEKDAYS } from '../AgentTaskDetail/scheduler/CronConfig';
import { initialSchedule } from './scheduleForm';

export const scheduleSummary = (
  pattern: string | null | undefined,
  timezone: string | null | undefined,
  config: Record<string, unknown> | undefined,
  t: TFunction<'chat'>,
) => {
  if (!pattern) return t('scheduledTasks.none');
  const parsed = initialSchedule(pattern, timezone, config);
  if (parsed.frequency === 'once')
    return t('scheduledTasks.once', { date: parsed.date, time: parsed.time });
  if (parsed.frequency === 'monthly')
    return t('scheduledTasks.monthly', { day: parsed.monthDay, time: parsed.time });
  if (parsed.frequency === 'weekdays') return t('scheduledTasks.weekdays', { time: parsed.time });
  // Preserve advanced patterns made through tools instead of misrepresenting them.
  if (!/^\d+ (?:\d+|\*|\*\/\d+) \* \* (?:\*|[0-6](?:,[0-6])*)$/.test(pattern))
    return t('scheduledTasks.custom', { pattern });
  const [minute, hour, , , weekdays] = pattern.split(' ');
  if (parsed.frequency === 'hourly') return t('scheduledTasks.custom', { pattern });
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (weekdays === '*') return t('taskSchedule.summary.daily', { time });
  const days = weekdays.split(',').map((day) => t(WEEKDAYS.find((entry) => entry.key === Number(day))!.label as any)).join('/');
  return t('taskSchedule.summary.weekly', { days, time });
};

export const nextScheduledDate = (
  pattern: string | null,
  timezone: string | null,
  config?: Record<string, unknown>,
): Date | null => {
  if (!pattern) return null;
  const schedule = config?.schedule as
    { endsAt?: string | null; onceAt?: string | null } | undefined;
  if (schedule?.onceAt) {
    const once = new Date(schedule.onceAt);
    return once > new Date() ? once : null;
  }
  const result = validateCronPattern(pattern, timezone, { count: 1 });
  if (!result.valid) return null;
  const next = result.nextRuns[0];
  return schedule?.endsAt && next > new Date(schedule.endsAt) ? null : next;
};

export const formatScheduledDate = (date: Date | string, timezone?: string | null) =>
  dayjs(date)
    .tz(timezone || 'UTC')
    .format('MM-DD · HH:mm');
