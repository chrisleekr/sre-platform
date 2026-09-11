CREATE TABLE "browser_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credential_hash" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"founding_id" uuid,
	"oidc_subject" text NOT NULL,
	"client_id" text NOT NULL,
	"oidc_session_id" text,
	"binding_claim_value" text,
	"authenticated_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_sessions_credential_hash_unique" UNIQUE("credential_hash"),
	CONSTRAINT "browser_sessions_expiry_check" CHECK ("browser_sessions"."idle_expires_at" <= "browser_sessions"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "mailbox_proofs" (
	"credential_hash" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"identity" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_attempts" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"browser_hash" text NOT NULL,
	"provider_id" uuid NOT NULL,
	"founding_id" uuid,
	"nonce" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
DROP INDEX "identity_providers_active_issuer_idx";--> statement-breakpoint
ALTER TABLE "identity_providers" ALTER COLUMN "audience" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "client_authentication" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_sessions" ADD CONSTRAINT "browser_sessions_founding_id_workspace_foundings_id_fk" FOREIGN KEY ("founding_id") REFERENCES "public"."workspace_foundings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_attempts" ADD CONSTRAINT "oidc_attempts_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oidc_attempts" ADD CONSTRAINT "oidc_attempts_founding_id_workspace_foundings_id_fk" FOREIGN KEY ("founding_id") REFERENCES "public"."workspace_foundings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "browser_sessions_user_idx" ON "browser_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "browser_sessions_provider_subject_idx" ON "browser_sessions" USING btree ("provider_id","oidc_subject");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_providers_active_issuer_idx" ON "identity_providers" USING btree ("issuer") WHERE "identity_providers"."status" = 'active' and "identity_providers"."scope" = 'installation';