-- A discussion round is one turn for every participant, not one published reply.
-- Rename the budget and record the current round. Replay is a no-op once applied.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'channel_discussions'
      AND column_name = 'max_turns'
  ) THEN
    ALTER TABLE "channel_discussions" RENAME COLUMN "max_turns" TO "max_rounds";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "channel_discussions" ADD COLUMN IF NOT EXISTS "round" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- Old budgets counted replies; keep them within the round cap rather than running dozens of rounds.
UPDATE "channel_discussions" SET "max_rounds" = 10 WHERE "max_rounds" > 10;--> statement-breakpoint
-- Work queued under the old per-reply budget belongs to round 1 so the current round can settle.
UPDATE "channel_jobs"
SET "task" = "task" || '{"round": 1}'::jsonb
WHERE "discussion_id" IS NOT NULL
  AND "task" IS NOT NULL
  AND "task" ->> 'kind' <> 'summarize'
  AND NOT ("task" ? 'round');
