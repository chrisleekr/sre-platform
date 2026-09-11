DROP INDEX "gitlab_hook_authorization_connector_uq";--> statement-breakpoint
ALTER TABLE "gitlab_hook_authorizations" ADD COLUMN "scope" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_hook_authorization_connector_uq" ON "gitlab_hook_authorizations" USING btree ("tenant_id","connector_id") WHERE "gitlab_hook_authorizations"."revoked_at" is null;