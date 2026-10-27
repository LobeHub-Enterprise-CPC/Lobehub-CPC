/** Time bounds shared by the dispatcher and queued execute handler. Invalid bounds fail closed. */
export const scheduleWindow = (
  config: unknown,
  now = new Date(),
): 'expired' | 'future' | 'invalid' | 'open' => {
  const schedule = (config as { schedule?: { endsAt?: unknown; onceAt?: unknown } } | null)
    ?.schedule;
  const parse = (value: unknown) =>
    typeof value === 'string' ? new Date(value).getTime() : Number.NaN;
  if (schedule?.endsAt != null) {
    const end = parse(schedule.endsAt);
    if (!Number.isFinite(end)) return 'invalid';
    if (now.getTime() > end) return 'expired';
  }
  if (schedule?.onceAt != null) {
    const start = parse(schedule.onceAt);
    if (!Number.isFinite(start)) return 'invalid';
    if (now.getTime() < start) return 'future';
  }
  return 'open';
};
