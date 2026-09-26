CREATE TABLE "channel_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"decision" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"target_id" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"member_id" text NOT NULL,
	"message_id" text NOT NULL,
	"thread_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_members" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"thread_id" text,
	"sequence" integer NOT NULL,
	"author_member_id" text,
	"content" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_key" text NOT NULL,
	"reply_to_id" text,
	"routing_status" text NOT NULL,
	"routing_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"kind" text NOT NULL,
	"target_id" text NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"job_id" text NOT NULL,
	"member_id" text NOT NULL,
	"session_id" text NOT NULL,
	"status" text DEFAULT 'starting' NOT NULL,
	"fence" integer DEFAULT 1 NOT NULL,
	"manifest" jsonb NOT NULL,
	"acceptance" text DEFAULT 'pending' NOT NULL,
	"native_turn_id" text,
	"publication_revoked" boolean DEFAULT false NOT NULL,
	"writer_released" boolean DEFAULT false NOT NULL,
	"draft" text,
	"published_message_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"member_id" text NOT NULL,
	"scope" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"native_session_id" text,
	"accepted_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_threads" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"root_message_id" text NOT NULL,
	"root_sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_workspace_locks" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"device_id" text NOT NULL,
	"directory" text NOT NULL,
	"run_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_jobs_delivery_idx" ON "channel_jobs" USING btree ("message_id","member_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_jobs_scope_idx" ON "channel_jobs" USING btree ("channel_id","id");
--> statement-breakpoint
CREATE INDEX "channel_jobs_queue_idx" ON "channel_jobs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_members_scope_idx" ON "channel_members" USING btree ("channel_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_scope_idx" ON "channel_messages" USING btree ("channel_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_seq_idx" ON "channel_messages" USING btree ("channel_id","sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_messages_request_idx" ON "channel_messages" USING btree ("channel_id","request_key");
--> statement-breakpoint
CREATE INDEX "channel_outbox_pending_idx" ON "channel_outbox" USING btree ("processed","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_runs_job_idx" ON "channel_runs" USING btree ("job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_runs_active_member_idx" ON "channel_runs" USING btree ("member_id") WHERE "channel_runs"."writer_released" = false;
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_sessions_member_scope_idx" ON "channel_sessions" USING btree ("member_id","scope");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_root_idx" ON "channel_threads" USING btree ("channel_id","root_message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_threads_scope_idx" ON "channel_threads" USING btree ("channel_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "channel_workspace_locks_resource_idx" ON "channel_workspace_locks" USING btree ("owner_id","device_id","directory");
--> statement-breakpoint
CREATE INDEX "channels_owner_idx" ON "channels" USING btree ("owner_id");
--> statement-breakpoint
ALTER TABLE "channel_approvals" ADD CONSTRAINT "channel_approvals_run_id_channel_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."channel_runs"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_audit" ADD CONSTRAINT "channel_audit_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD CONSTRAINT "channel_jobs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD CONSTRAINT "channel_jobs_member_fk" FOREIGN KEY ("channel_id","member_id") REFERENCES "public"."channel_members"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD CONSTRAINT "channel_jobs_message_fk" FOREIGN KEY ("channel_id","message_id") REFERENCES "public"."channel_messages"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_jobs" ADD CONSTRAINT "channel_jobs_thread_fk" FOREIGN KEY ("channel_id","thread_id") REFERENCES "public"."channel_threads"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_members" ADD CONSTRAINT "channel_members_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_thread_fk" FOREIGN KEY ("channel_id","thread_id") REFERENCES "public"."channel_threads"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_author_fk" FOREIGN KEY ("channel_id","author_member_id") REFERENCES "public"."channel_members"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_outbox" ADD CONSTRAINT "channel_outbox_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_runs" ADD CONSTRAINT "channel_runs_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_runs" ADD CONSTRAINT "channel_runs_session_id_channel_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."channel_sessions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_runs" ADD CONSTRAINT "channel_runs_job_fk" FOREIGN KEY ("channel_id","job_id") REFERENCES "public"."channel_jobs"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_runs" ADD CONSTRAINT "channel_runs_member_fk" FOREIGN KEY ("channel_id","member_id") REFERENCES "public"."channel_members"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_sessions" ADD CONSTRAINT "channel_sessions_member_fk" FOREIGN KEY ("channel_id","member_id") REFERENCES "public"."channel_members"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_threads" ADD CONSTRAINT "channel_threads_root_fk" FOREIGN KEY ("channel_id","root_message_id") REFERENCES "public"."channel_messages"("channel_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_workspace_locks" ADD CONSTRAINT "channel_workspace_locks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channel_workspace_locks" ADD CONSTRAINT "channel_workspace_locks_run_id_channel_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."channel_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
