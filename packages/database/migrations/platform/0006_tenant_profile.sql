CREATE TABLE "tenant_slug_alias" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_directory" ADD COLUMN "profile_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_slug_alias" ADD CONSTRAINT "tenant_slug_alias_tenant_id_tenant_directory_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant_directory"("tenant_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_slug_alias_tenant_idx" ON "tenant_slug_alias" USING btree ("tenant_id");