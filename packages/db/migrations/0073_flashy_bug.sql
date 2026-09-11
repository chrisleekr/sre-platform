ALTER TABLE "gitlab_projects" ADD COLUMN "poll_cursor" jsonb;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD COLUMN "poll_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD COLUMN "poll_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD COLUMN "poll_failure_category" text;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD COLUMN "poll_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "gitlab_projects_poll_idx" ON "gitlab_projects" USING btree ("tenant_id","connector_id","removed_at","poll_attempted_at");