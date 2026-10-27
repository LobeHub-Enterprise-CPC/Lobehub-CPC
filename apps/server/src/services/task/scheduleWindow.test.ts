import { describe, expect, it } from 'vitest';

import { scheduleWindow } from './scheduleWindow';

const now = new Date('2030-10-10T08:00:00Z');
describe('scheduleWindow', () => {
  it('keeps existing schedules open and enforces both boundaries', () => {
    expect(scheduleWindow({}, now)).toBe('open');
    expect(
      scheduleWindow({ schedule: { onceAt: now.toISOString(), endsAt: now.toISOString() } }, now),
    ).toBe('open');
    expect(scheduleWindow({ schedule: { onceAt: '2030-10-11T08:00:00Z' } }, now)).toBe('future');
    expect(scheduleWindow({ schedule: { endsAt: '2030-10-09T08:00:00Z' } }, now)).toBe('expired');
  });
  it.each([{ endsAt: 'nonsense' }, { onceAt: 'nonsense' }, { endsAt: 123 }])(
    'fails closed on invalid config %s',
    (schedule) => {
      expect(scheduleWindow({ schedule }, now)).toBe('invalid');
    },
  );
});
