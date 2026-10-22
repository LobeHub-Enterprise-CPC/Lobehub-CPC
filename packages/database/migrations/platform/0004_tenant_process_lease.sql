DROP TABLE "tenant_runtime_claim" CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" ADD COLUMN "lease_expires_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" ADD COLUMN "drained_generations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "host";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "host_id";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "boot_id";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "pid_ns";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "pid_start_ticks";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "pid";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "state";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "retired_at";--> statement-breakpoint
ALTER TABLE "tenant_runtime_process" DROP COLUMN "retired_evidence";