-- Tables only a tenant schema has (src/tenant/schemas.ts). The shared chain
-- (../) runs first; both are written for the public schema and the tenant
-- migrator rewrites that to the tenant schema.
CREATE TABLE "public"."tenant_metadata" (
	"datasource_kind" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"schema_version" text NOT NULL,
	"tenant_id" text PRIMARY KEY NOT NULL
);--> statement-breakpoint
CREATE TABLE "public"."sso_providers" (
	"admission_policy" text DEFAULT 'allowlist' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"logo_url" text,
	"oauth2_config" text,
	"oidc_config" text,
	"protocol" text NOT NULL,
	"provider_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"saml_config" text,
	"secret_config_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_provider_id_idx" ON "public"."sso_providers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "sso_providers_enabled_idx" ON "public"."sso_providers" USING btree ("enabled");
