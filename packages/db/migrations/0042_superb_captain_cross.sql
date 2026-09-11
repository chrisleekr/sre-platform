ALTER TABLE "incident_relations" DROP CONSTRAINT "incident_relations_type_vocabulary";--> statement-breakpoint
DROP INDEX "alert_cohorts_collecting_idx";--> statement-breakpoint
ALTER TABLE "alert_cohorts" ALTER COLUMN "data_source_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD COLUMN "source_scope_key" text;--> statement-breakpoint
UPDATE "alert_cohorts" SET "source_scope_key" = 'connector:' || "data_source_id"::text;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ALTER COLUMN "source_scope_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD COLUMN "evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD COLUMN "confidence" integer;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD COLUMN "decision_run_id" uuid;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_decision_run_fk" FOREIGN KEY ("tenant_id","decision_run_id") REFERENCES "public"."investigation_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_relations_active_causal_parent_uq" ON "incident_relations" USING btree ("tenant_id","source_incident_id") WHERE "incident_relations"."type" = 'caused_by' and "incident_relations"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "incident_signals_surface_monitor_active_idx" ON "incident_signals" USING btree ("tenant_id","surface","channel","monitor_key","state","last_seen_at" DESC NULLS LAST) WHERE "incident_signals"."data_source_id" is null and "incident_signals"."monitor_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_cohort_analysis_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'cohortId')) WHERE type = 'cohort.analyze' AND status IN ('queued','processing');--> statement-breakpoint
CREATE INDEX "alert_cohorts_collecting_idx" ON "alert_cohorts" USING btree ("tenant_id","source_scope_key","state","window_ends_at");--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_source_scope_present" CHECK (btrim("alert_cohorts"."source_scope_key") <> '');--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_confidence_range" CHECK ("incident_relations"."confidence" is null or ("incident_relations"."confidence" >= 0 and "incident_relations"."confidence" <= 100));--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_agent_causal_evidence" CHECK ("incident_relations"."type" <> 'caused_by' or "incident_relations"."decided_by" <> 'agent' or ("incident_relations"."decision_run_id" is not null and "incident_relations"."confidence" is not null and cardinality("incident_relations"."evidence_ids") > 0));--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_type_vocabulary" CHECK (type in ('possible_related', 'caused_by', 'recurrence_of', 'merged_into', 'split_from', 'unrelated'));
