ALTER TABLE "deployments" DROP CONSTRAINT "deployments_tenant_source_sha_uq";--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_failure_category" text;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_snapshot_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_error_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_failure_category" text;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "environment" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "actor" text;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "provider_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "provider_updated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_provider_event_uq" ON "deployments" USING btree ("tenant_id","source","repo","provider_id") WHERE "deployments"."provider_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_legacy_sha_uq" ON "deployments" USING btree ("tenant_id","source","sha") WHERE "deployments"."provider_id" is null;