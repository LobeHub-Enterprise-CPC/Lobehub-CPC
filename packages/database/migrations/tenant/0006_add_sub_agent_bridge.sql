CREATE TABLE "agent_sub_agent_bridges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"child_operation_id" text NOT NULL,
	"parent_operation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text,
	"include_share_visitor" boolean DEFAULT false NOT NULL,
	"thread_id" text NOT NULL,
	"tool_message_id" text NOT NULL,
	"child_run_token" text NOT NULL,
	"waiting_batch_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"completion_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sub_agent_bridges_child_operation_id_idx" ON "agent_sub_agent_bridges" USING btree ("child_operation_id");--> statement-breakpoint
CREATE INDEX "agent_sub_agent_bridges_status_updated_at_idx" ON "agent_sub_agent_bridges" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "agent_sub_agent_bridges_parent_operation_id_idx" ON "agent_sub_agent_bridges" USING btree ("parent_operation_id");