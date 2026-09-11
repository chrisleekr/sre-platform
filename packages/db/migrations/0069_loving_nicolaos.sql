CREATE TABLE "backchannel_logout_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"jti_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backchannel_logout_receipts_provider_id_jti_hash_unique" UNIQUE("provider_id","jti_hash")
);
--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "backchannel_logout" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "backchannel_logout_typ_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backchannel_logout_receipts" ADD CONSTRAINT "backchannel_logout_receipts_provider_id_identity_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."identity_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backchannel_logout_receipts_expiry_idx" ON "backchannel_logout_receipts" USING btree ("expires_at");