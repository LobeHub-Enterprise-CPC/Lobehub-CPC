CREATE TABLE "tenant_directory" (
	"connection_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_bundle_version" integer NOT NULL,
	"database" text NOT NULL,
	"deployment_ref" text NOT NULL,
	"host" text NOT NULL,
	"mode" text NOT NULL,
	"name" text NOT NULL,
	"owner_secret" text NOT NULL,
	"owner_username" text NOT NULL,
	"port" integer NOT NULL,
	"runtime_secret" text NOT NULL,
	"runtime_username" text NOT NULL,
	"schema_name" text NOT NULL,
	"schema_version" integer NOT NULL,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"tenant_id" text PRIMARY KEY NOT NULL,
	"tls" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_lifecycle" (
	"accepted_version" integer DEFAULT 0 NOT NULL,
	"applied_version" integer DEFAULT 0 NOT NULL,
	"desired_state" text NOT NULL,
	"expires_at" timestamp with time zone,
	"freeze_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tenant_id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_lifecycle_applied_le_accepted" CHECK ("tenant_lifecycle"."applied_version" <= "tenant_lifecycle"."accepted_version")
);
--> statement-breakpoint
CREATE TABLE "tenant_lifecycle_inbox" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_code" text,
	"event_id" text PRIMARY KEY NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"tenant_id" text NOT NULL,
	"version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_provision_operation" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_bundle_version" integer,
	"datasource_ready" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"input_hash" text NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"name" text NOT NULL,
	"operation_id" text PRIMARY KEY NOT NULL,
	"pending_bundle" text,
	"schema_name" text,
	"schema_version" integer,
	"slug" text NOT NULL,
	"status" text NOT NULL,
	"step" text NOT NULL,
	"tenant_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_directory_slug_idx" ON "tenant_directory" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_directory_schema_name_idx" ON "tenant_directory" USING btree ("schema_name");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_lifecycle_inbox_tenant_version_idx" ON "tenant_lifecycle_inbox" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_inbox_status_idx" ON "tenant_lifecycle_inbox" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tenant_provision_operation_tenant_idx" ON "tenant_provision_operation" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_provision_operation_slug_idx" ON "tenant_provision_operation" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "tenant_provision_operation_status_idx" ON "tenant_provision_operation" USING btree ("status");