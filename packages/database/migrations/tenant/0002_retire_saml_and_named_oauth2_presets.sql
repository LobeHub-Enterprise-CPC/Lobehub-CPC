-- SAML and the named OAuth2 vendors (dingtalk, wecom, discord, feishu, github) are no longer
-- supported. Soft-delete the stored providers; revision is untouched because it is part of the
-- secret AAD (tenantId|providerId|revision).
UPDATE "sso_providers" SET "enabled" = false, "deleted_at" = COALESCE("deleted_at", now()), "updated_at" = now() WHERE "deleted_at" IS NULL AND ("protocol" = 'saml' OR ("protocol" = 'oauth2' AND COALESCE("oauth2_config"->>'preset', '') <> 'custom'));
