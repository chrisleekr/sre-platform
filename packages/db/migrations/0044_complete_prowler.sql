ALTER TABLE "alert_cohorts" DROP CONSTRAINT "alert_cohorts_state_vocabulary";--> statement-breakpoint
DROP INDEX "jobs_cohort_analysis_coalesce_idx";--> statement-breakpoint
DROP INDEX "jobs_relation_reassessment_coalesce_idx";--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD COLUMN "analysis_job_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_cohort_analysis_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'cohortId')) WHERE type = 'cohort.analyze' AND status = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_relation_reassessment_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'incidentId')) WHERE type = 'relation.reassess' AND status = 'queued';--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_analysis_job_present" CHECK (state <> 'analyzing' or "alert_cohorts"."analysis_job_id" is not null);--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_state_vocabulary" CHECK (state in ('collecting', 'analyzing', 'settled'));
