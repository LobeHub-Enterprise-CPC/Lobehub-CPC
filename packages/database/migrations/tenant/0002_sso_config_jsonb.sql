ALTER TABLE "sso_providers" ALTER COLUMN "oauth2_config" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "sso_providers" ALTER COLUMN "oidc_config" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "sso_providers" ALTER COLUMN "saml_config" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_oauth2_config_object" CHECK (jsonb_typeof("sso_providers"."oauth2_config") = 'object');--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_oidc_config_object" CHECK (jsonb_typeof("sso_providers"."oidc_config") = 'object');--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_saml_config_object" CHECK (jsonb_typeof("sso_providers"."saml_config") = 'object');