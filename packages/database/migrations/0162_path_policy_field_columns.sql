ALTER TABLE "command_execution_logs" ALTER COLUMN "command_text" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "command_execution_logs" ADD COLUMN IF NOT EXISTS "path" text;--> statement-breakpoint
ALTER TABLE "command_execution_logs" ADD COLUMN IF NOT EXISTS "policy_field" text;