ALTER TABLE "incident_tag_suggestions" DROP CONSTRAINT "incident_tag_suggestions_applied_tag_fk";
--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD COLUMN "promotion_prompt_claim_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD COLUMN "promotion_prompt_claimed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_applied_tag_fk" FOREIGN KEY ("tenant_id","applied_tag_id") REFERENCES "public"."incident_tags"("tenant_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_job_uq" UNIQUE("tenant_id","job_id");--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_active_job" CHECK (status not in ('queued', 'running') or job_id is not null);