ALTER TABLE "connector_configs" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_rate_limit_remaining" integer;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "verification_rate_limit_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_rate_limit_remaining" integer;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "poll_rate_limit_reset_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "transient_environment" boolean DEFAULT false NOT NULL;