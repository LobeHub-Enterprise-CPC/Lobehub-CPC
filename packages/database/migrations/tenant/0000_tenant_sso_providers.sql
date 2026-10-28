CREATE TABLE "sso_providers" (
	"admission_policy" text DEFAULT 'allowlist' NOT NULL,
	"bridge_config" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"logo_url" text,
	"oauth2_config" jsonb,
	"oidc_config" jsonb,
	"protocol" text NOT NULL,
	"provider_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"saml_config" jsonb,
	"secret_config_encrypted" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_oauth2_config_object" CHECK (jsonb_typeof("sso_providers"."oauth2_config") = 'object'),
	CONSTRAINT "sso_providers_oidc_config_object" CHECK (jsonb_typeof("sso_providers"."oidc_config") = 'object'),
	CONSTRAINT "sso_providers_saml_config_object" CHECK (jsonb_typeof("sso_providers"."saml_config") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sso_providers_provider_id_idx" ON "sso_providers" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "sso_providers_enabled_idx" ON "sso_providers" USING btree ("enabled");