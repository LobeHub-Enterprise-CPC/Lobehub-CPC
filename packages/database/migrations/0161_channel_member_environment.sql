ALTER TABLE "channel_members" ADD COLUMN "execution_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_members" ADD COLUMN "environment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_members" ADD COLUMN "environment_cutoff" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "execution_fence" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "execution_config" jsonb;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "environment_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "physical_stopped" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "cleanup_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "environment_error" text;--> statement-breakpoint
-- Membership environments were immutable before this migration. Preserve their old routing.
-- Receipt fences start at 1; subsequent fence changes only transfer draft publication authority.
UPDATE "channel_runs" AS r SET "execution_config" = m."config"
FROM "channel_members" AS m WHERE r."member_id" = m."id";--> statement-breakpoint
-- Native release waits for all tools. Heterogeneous completion may retain background processes.
UPDATE "channel_runs" SET "physical_stopped" = true
WHERE "writer_released" = true AND "execution_config"->>'runtime' = 'native';
