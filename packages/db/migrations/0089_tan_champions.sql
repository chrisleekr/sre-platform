ALTER TABLE "alert_episode_intakes" ALTER COLUMN "starts_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD COLUMN "opaque_episode_key" text;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_opaque_episode_uq" UNIQUE("tenant_id","data_source_id","opaque_episode_key");