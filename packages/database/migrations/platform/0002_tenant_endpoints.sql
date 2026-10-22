CREATE TABLE "tenant_endpoint_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"version" integer NOT NULL,
	"payload_hash" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_endpoint_state" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"accepted_version" integer NOT NULL,
	"applied_version" integer NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_endpoint_version_positive" CHECK ("tenant_endpoint_state"."applied_version" > 0 AND "tenant_endpoint_state"."applied_version" = "tenant_endpoint_state"."accepted_version")
);
--> statement-breakpoint
CREATE TABLE "tenant_endpoints" (
	"tenant_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"host" text,
	"active" boolean NOT NULL,
	CONSTRAINT "tenant_endpoints_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "tenant_endpoints_kind_valid" CHECK (("tenant_endpoints"."kind" = 'default' AND "tenant_endpoints"."id" = 'default' AND "tenant_endpoints"."host" IS NULL) OR ("tenant_endpoints"."kind" = 'custom' AND "tenant_endpoints"."id" <> 'default' AND "tenant_endpoints"."host" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tenant_endpoint_events" ADD CONSTRAINT "tenant_endpoint_events_tenant_id_tenant_directory_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant_directory"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_endpoint_state" ADD CONSTRAINT "tenant_endpoint_state_tenant_id_tenant_directory_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant_directory"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_endpoints" ADD CONSTRAINT "tenant_endpoints_tenant_id_tenant_directory_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant_directory"("tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_endpoint_events_version_idx" ON "tenant_endpoint_events" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_endpoints_host_idx" ON "tenant_endpoints" USING btree ("host");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_endpoints_active_idx" ON "tenant_endpoints" USING btree ("tenant_id") WHERE "tenant_endpoints"."active";