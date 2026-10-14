ALTER TABLE "oidc_authorization_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "oidc_sessions" ALTER COLUMN "user_id" DROP NOT NULL;