-- A run whose termination cannot be confirmed is logically isolated (isolated_at) instead of
-- holding its member's writer slot forever; writer_released keeps meaning physical confirmation.
DROP INDEX "channel_runs_active_member_idx";--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN "isolated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_runs_active_member_idx" ON "channel_runs" USING btree ("member_id") WHERE "channel_runs"."writer_released" = false AND "channel_runs"."isolated_at" IS NULL;