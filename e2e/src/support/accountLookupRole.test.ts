import { describe, expect, it, vi } from 'vitest';

import { ensureAccountLookupRole } from './accountLookupRole';

const client = (rowCount: number) => {
  const query = vi.fn().mockResolvedValue({ rowCount });
  return { query };
};

describe('ensureAccountLookupRole', () => {
  it('creates the Console lookup role with a login password when it is missing', async () => {
    const db = client(0);

    await ensureAccountLookupRole(db, 'e2e_sync1022_cpc');

    expect(db.query).toHaveBeenNthCalledWith(1, 'SELECT 1 FROM pg_roles WHERE rolname = $1', [
      'tituwork_account_lookup',
    ]);
    expect(db.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        'CREATE ROLE "tituwork_account_lookup" LOGIN PASSWORD \'tituwork_account_lookup-e2e\'',
      ),
    );
    expect(db.query).toHaveBeenNthCalledWith(
      3,
      'GRANT CONNECT ON DATABASE "e2e_sync1022_cpc" TO "tituwork_account_lookup"',
    );
  });

  it('keeps an existing role and only grants CONNECT on this database', async () => {
    const db = client(1);

    await ensureAccountLookupRole(db, 'e2e_sync1022_cpc');

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][0]).toContain('SELECT 1 FROM pg_roles');
    expect(db.query.mock.calls[1][0]).toBe(
      'GRANT CONNECT ON DATABASE "e2e_sync1022_cpc" TO "tituwork_account_lookup"',
    );
  });
});
