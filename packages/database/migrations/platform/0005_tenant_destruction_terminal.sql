CREATE TABLE "tenant_destruction" (
	"completed_at" timestamp with time zone,
	"destroy_operation_id" text NOT NULL,
	"drain_result" text,
	"tenant_id" text PRIMARY KEY NOT NULL,
	"terminal_established_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_destruction_drain_result_valid" CHECK ("tenant_destruction"."drain_result" IS NULL OR "tenant_destruction"."drain_result" IN ('drained', 'fenced')),
	CONSTRAINT "tenant_destruction_completed_after_drain" CHECK ("tenant_destruction"."completed_at" IS NULL OR "tenant_destruction"."drain_result" IS NOT NULL)
);
