CREATE TABLE "tenant_runtime_claim" (
	"tenant_id" text NOT NULL,
	"process_id" text NOT NULL,
	"claim_token" text NOT NULL,
	"claimed_version" integer NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"stop_version" integer,
	"stop_error" text,
	"stop_error_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tenant_runtime_claim_tenant_id_process_id_pk" PRIMARY KEY("tenant_id","process_id"),
	CONSTRAINT "tenant_runtime_claim_count_nonnegative" CHECK ("tenant_runtime_claim"."open_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tenant_runtime_cutover" (
	"id" text PRIMARY KEY NOT NULL,
	"enforced_at" timestamp with time zone,
	"evidence" text,
	"build_ref" text,
	CONSTRAINT "tenant_runtime_cutover_singleton" CHECK ("tenant_runtime_cutover"."id" = 'strict-stop')
);
--> statement-breakpoint
CREATE TABLE "tenant_runtime_external_work" (
	"work_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"handle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_runtime_process" (
	"process_id" text PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"host_id" text,
	"boot_id" text,
	"pid_ns" text,
	"pid_start_ticks" text,
	"pid" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"retired_at" timestamp with time zone,
	"retired_evidence" jsonb
);
--> statement-breakpoint
ALTER TABLE "tenant_runtime_claim" ADD CONSTRAINT "tenant_runtime_claim_process_id_tenant_runtime_process_process_id_fk" FOREIGN KEY ("process_id") REFERENCES "public"."tenant_runtime_process"("process_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_runtime_external_work_tenant_idx" ON "tenant_runtime_external_work" USING btree ("tenant_id");