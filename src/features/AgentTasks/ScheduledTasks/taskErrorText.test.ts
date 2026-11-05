import { describe, expect, it } from 'vitest';

import { getTaskErrorText } from './taskErrorText';

// Stands in for i18next: returns the looked-up key so the test sees which copy
// was picked, or the default value when the key is unknown.
const t = (key: string, vars?: { defaultValue?: string }) =>
  key.startsWith('modelRuntime:') ? `[${key}]` : (vars?.defaultValue ?? key);

describe('getTaskErrorText', () => {
  it('shows the localized copy of an internal failure', () => {
    expect(getTaskErrorText(t, 'A database operation failed.', 'DatabasePersistError')).toBe(
      '[modelRuntime:DatabasePersistError]',
    );
  });

  it('shows a PostgreSQL bucket as the database failure', () => {
    expect(getTaskErrorText(t, 'A database operation failed.', 'pg_XX000')).toBe(
      '[modelRuntime:DatabasePersistError]',
    );
  });

  it("keeps a provider failure's own text", () => {
    expect(getTaskErrorText(t, 'insufficient quota', 'InsufficientQuota')).toBe(
      'insufficient quota',
    );
  });

  it('keeps the stored text when the failure has no type', () => {
    expect(getTaskErrorText(t, 'Heartbeat timeout', undefined)).toBe('Heartbeat timeout');
  });
});
