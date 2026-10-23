import { TEST_USER } from './seedTestUser';
import { tenantClientConfig } from './tenant';

/**
 * Give the Home rail a deterministic card.
 *
 * A fresh account has no inbox rows, and the suggestions card depends on the
 * hosted recommendation feed, so the rail can legitimately stay empty. Layout
 * assertions need something with a known height and width in it, so seed one
 * `insight` brief: it is day-scoped news, which the rail renders as a card.
 */
export async function seedHomeRailBrief(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the Home rail scenario');

  const { default: pg } = await import('pg');
  const client = new pg.Client(tenantClientConfig(databaseUrl));

  await client.connect();

  try {
    await client.query(
      `INSERT INTO briefs (id, user_id, type, priority, title, summary)
       VALUES ($1, $2, 'insight', 'info', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        `brief_e2e_home_rail_${TEST_USER.id}`,
        TEST_USER.id,
        'E2E rail layout fixture',
        'Deterministic Home rail content for the dashboard layout scenario.',
      ],
    );
  } finally {
    await client.end();
  }
}
