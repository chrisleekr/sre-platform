CREATE TABLE "directory_account_links" (
	"provider_id" uuid NOT NULL,
	"directory_account_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_account_links_directory_account_id_unique" UNIQUE("directory_account_id"),
	CONSTRAINT "directory_account_links_provider_id_user_id_unique" UNIQUE("provider_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "directory_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"external_id" text,
	"user_name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"name" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_accounts_id_provider_id_unique" UNIQUE("id","provider_id")
);
--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "scim_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "scim_token_hash" text;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "scim_token_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "scim_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "require_provisioned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "scim_identity_attribute" text DEFAULT 'externalId' NOT NULL;--> statement-breakpoint
ALTER TABLE "directory_account_links" ADD CONSTRAINT "directory_account_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_account_links" ADD CONSTRAINT "directory_account_links_directory_account_id_provider_id_directory_accounts_id_provider_id_fk" FOREIGN KEY ("directory_account_id","provider_id") REFERENCES "public"."directory_accounts"("id","provider_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "directory_accounts" ADD CONSTRAINT "directory_accounts_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "directory_account_links_user_idx" ON "directory_account_links" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "directory_accounts_provider_username_current_idx" ON "directory_accounts" USING btree ("provider_id",lower("user_name")) WHERE "directory_accounts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "directory_accounts_provider_external_id_current_idx" ON "directory_accounts" USING btree ("provider_id","external_id") WHERE "directory_accounts"."deleted_at" is null and "directory_accounts"."external_id" is not null;--> statement-breakpoint
CREATE INDEX "directory_accounts_provider_updated_idx" ON "directory_accounts" USING btree ("provider_id","updated_at");--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_scim_attribute_check" CHECK ("identity_providers"."scim_identity_attribute" in ('externalId','userName'));--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_scim_credential_check" CHECK ("identity_providers"."scim_enabled" = ("identity_providers"."scim_token_hash" is not null and "identity_providers"."scim_token_created_at" is not null and "identity_providers"."scim_token_expires_at" is not null));--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_scim_eligibility_check" CHECK (not "identity_providers"."scim_enabled" or ("identity_providers"."kind" = 'oidc' and "identity_providers"."browser_client_id" is not null));--> statement-breakpoint
ALTER TABLE "identity_providers" ADD CONSTRAINT "identity_providers_scim_policy_check" CHECK (not "identity_providers"."require_provisioned" or "identity_providers"."scim_enabled");