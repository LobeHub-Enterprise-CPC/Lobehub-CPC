import { describe, expect, it } from 'vitest';

import { buildSchedule, initialSchedule, validateScheduleForm } from './scheduleForm';

const base = () => ({
  ...initialSchedule(undefined, 'Asia/Shanghai'),
  date: '2030-10-10',
  time: '08:17',
});

describe('scheduled task form', () => {
  it.each([
    ['daily', '17 8 * * *'],
    ['weekly', '17 8 * * 1'],
    ['weekdays', '17 8 * * 1-5'],
    ['monthly', '17 8 1 * *'],
    ['hourly', '0 */1 * * *'],
    ['once', '17 8 10 10 *'],
  ] as const)('stores %s without rounding the requested minute', (frequency, pattern) => {
    const value = { ...base(), frequency };
    expect(buildSchedule(value).schedulePattern).toBe(pattern);
  });
  it('bounds a one-shot schedule to its selected date, including the dispatch grace window', () => {
    const result = buildSchedule({ ...base(), frequency: 'once' });
    expect(result.schedule).toEqual({
      onceAt: '2030-10-10T00:17:00.000Z',
      endsAt: '2030-10-10T00:42:00.000Z',
      maxExecutions: 1,
    });
  });
  it('preserves timezone and end date on reopening', () => {
    const value = {
      ...base(),
      ends: true,
      endDate: '2030-10-20',
      frequency: 'monthly' as const,
      monthDay: 19,
    };
    const result = buildSchedule(value);
    expect(
      initialSchedule(result.schedulePattern, result.scheduleTimezone, {
        schedule: result.schedule,
      }),
    ).toMatchObject({
      frequency: 'monthly',
      monthDay: 19,
      time: '08:17',
      ends: true,
      endDate: '2030-10-20',
    });
  });
  it('rejects past one-shot dates and invalid interval values', () => {
    expect(validateScheduleForm({ ...base(), frequency: 'once' }, new Date('2031-01-01'))).toBe(
      'invalidDate',
    );
    expect(validateScheduleForm({ ...base(), frequency: 'hourly', interval: 0 })).toBe(
      'invalidInterval',
    );
    expect(validateScheduleForm({ ...base(), frequency: 'hourly', interval: 1.5 })).toBe(
      'invalidInterval',
    );
  });
  it('rejects end dates before execution and impossible calendar dates', () => {
    expect(
      validateScheduleForm(
        { ...base(), ends: true, endDate: '2026-02-30' },
        new Date('2026-01-01'),
      ),
    ).toBe('invalidEnd');
    expect(
      validateScheduleForm(
        { ...base(), frequency: 'once', date: '2030-02-30' },
        new Date('2026-01-01'),
      ),
    ).toBe('invalidDate');
  });
  it('clears a disabled end date from the stored schedule', () => {
    expect(
      buildSchedule({ ...base(), ends: false, endDate: '2030-10-20' }).schedule.endsAt,
    ).toBeNull();
  });
});
