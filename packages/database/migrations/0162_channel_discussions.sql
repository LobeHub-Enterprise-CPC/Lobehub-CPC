CREATE TABLE IF NOT EXISTS "channel_discussions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"request_message_id" text NOT NULL,
	"thread_id" text,
	"participant_ids" jsonb NOT NULL,
	"max_turns" integer NOT NULL,
	"turns_published" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"end_reason" text,
	"summary_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "channel_jobs_delivery_idx";--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD COLUMN IF NOT EXISTS "discussion_id" text;--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD COLUMN IF NOT EXISTS "task" jsonb;--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD COLUMN IF NOT EXISTS "delivery_key" text DEFAULT 'initial' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_runs" ADD COLUMN IF NOT EXISTS "publication_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "channel_discussions" DROP CONSTRAINT IF EXISTS "channel_discussions_channel_id_channels_id_fk";--> statement-breakpoint
ALTER TABLE "channel_discussions" ADD CONSTRAINT "channel_discussions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_discussions" DROP CONSTRAINT IF EXISTS "channel_discussions_request_message_id_channel_messages_id_fk";--> statement-breakpoint
ALTER TABLE "channel_discussions" ADD CONSTRAINT "channel_discussions_request_message_id_channel_messages_id_fk" FOREIGN KEY ("request_message_id") REFERENCES "public"."channel_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_discussions_channel_status_idx" ON "channel_discussions" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_discussions_request_idx" ON "channel_discussions" USING btree ("request_message_id");--> statement-breakpoint
ALTER TABLE "channel_jobs" DROP CONSTRAINT IF EXISTS "channel_jobs_discussion_id_channel_discussions_id_fk";--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD CONSTRAINT "channel_jobs_discussion_id_channel_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."channel_discussions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_approvals_run_idx" ON "channel_approvals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_jobs_channel_status_idx" ON "channel_jobs" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_thread_sequence_idx" ON "channel_messages" USING btree ("channel_id","thread_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_request_sequence_idx" ON "channel_messages" USING btree ("channel_id","thread_id","sequence") WHERE "channel_messages"."author_member_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_messages_routing_pending_idx" ON "channel_messages" USING btree ("channel_id","id") WHERE "channel_messages"."routing_status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_runs_unsettled_idx" ON "channel_runs" USING btree ("channel_id","id") WHERE "channel_runs"."writer_released" = false OR "channel_runs"."physical_stopped" = false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_jobs_delivery_idx" ON "channel_jobs" USING btree ("message_id","member_id","delivery_key");
