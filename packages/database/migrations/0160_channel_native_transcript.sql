CREATE TABLE "channel_runtime_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"run_id" text NOT NULL,
	"stable_key" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_runtime_states" (
	"session_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_runtime_messages" ADD CONSTRAINT "channel_runtime_messages_session_id_channel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_runtime_messages" ADD CONSTRAINT "channel_runtime_messages_run_id_channel_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."channel_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_runtime_states" ADD CONSTRAINT "channel_runtime_states_session_id_channel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_runtime_states" ADD CONSTRAINT "channel_runtime_states_run_id_channel_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."channel_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_runtime_messages_key_idx" ON "channel_runtime_messages" USING btree ("session_id","stable_key");