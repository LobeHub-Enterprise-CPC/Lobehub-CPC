ALTER TABLE "tenant_runtime_external_work" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "tenant_runtime_external_work" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenant_runtime_external_work" ADD COLUMN "receipt" jsonb;