-- Explicit data conversion: drizzle-kit does not generate USING for text -> jsonb.
-- Invalid legacy JSON aborts the transaction; no row or journal entry is discarded.
ALTER TABLE "sso_providers"
  ALTER COLUMN "oauth2_config" TYPE jsonb USING "oauth2_config"::jsonb,
  ALTER COLUMN "oidc_config" TYPE jsonb USING "oidc_config"::jsonb,
  ALTER COLUMN "saml_config" TYPE jsonb USING "saml_config"::jsonb;
