ALTER TABLE "deployments" ADD COLUMN "revisions" jsonb;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "operation_phase" text;--> statement-breakpoint
DROP INDEX "deployments_provider_event_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_provider_event_uq" ON "deployments" USING btree ("tenant_id","source","repo","provider_id") WHERE "deployments"."provider_id" is not null and "deployments"."source" <> 'argocd';--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_argocd_provider_event_uq" ON "deployments" USING btree ("tenant_id","source","provider_id") WHERE "deployments"."provider_id" is not null and "deployments"."source" = 'argocd';--> statement-breakpoint
UPDATE "connector_configs"
SET "enabled" = false,
    "lifecycle_version" = "lifecycle_version" + 1,
    "verification_attempted_at" = NULL,
    "verification_succeeded_at" = NULL,
    "verification_failure_category" = NULL,
    "verification_duration_ms" = NULL,
    "verification_rate_limit_remaining" = NULL,
    "verification_rate_limit_reset_at" = NULL,
    "poll_attempted_at" = NULL,
    "poll_succeeded_at" = NULL,
    "poll_snapshot_count" = 0,
    "poll_error_count" = 0,
    "poll_failure_category" = NULL,
    "poll_duration_ms" = NULL,
    "poll_rate_limit_remaining" = NULL,
    "poll_rate_limit_reset_at" = NULL,
    "poll_cursor" = NULL,
    "updated_at" = now()
WHERE "type" = 'argocd';
