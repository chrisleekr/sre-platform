CREATE TABLE "assessment_grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"claimed_confidence" integer NOT NULL,
	"runbook_cited" boolean NOT NULL,
	"model_verdict" text,
	"model_rationale" text,
	"ground_truth_source" text,
	"human_verdict" text,
	"human_rationale" text,
	"graded_by_user_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assessment_grades_confidence_range" CHECK ("assessment_grades"."claimed_confidence" >= 0 and "assessment_grades"."claimed_confidence" <= 100),
	CONSTRAINT "assessment_grades_model_verdict_vocabulary" CHECK ("assessment_grades"."model_verdict" is null or model_verdict in ('correct', 'partial', 'incorrect')),
	CONSTRAINT "assessment_grades_human_verdict_vocabulary" CHECK ("assessment_grades"."human_verdict" is null or human_verdict in ('correct', 'partial', 'incorrect')),
	CONSTRAINT "assessment_grades_ground_truth_vocabulary" CHECK ("assessment_grades"."ground_truth_source" is null or ground_truth_source in ('postmortem')),
	CONSTRAINT "assessment_grades_ground_truth_shape" CHECK (("assessment_grades"."model_verdict" is null) = ("assessment_grades"."ground_truth_source" is null)),
	CONSTRAINT "assessment_grades_has_a_verdict" CHECK ("assessment_grades"."model_verdict" is not null or "assessment_grades"."human_verdict" is not null),
	CONSTRAINT "assessment_grades_human_attribution" CHECK (("assessment_grades"."human_verdict" is null) = ("assessment_grades"."graded_by_user_id" is null))
);
--> statement-breakpoint
ALTER TABLE "assessment_grades" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "postmortem_action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"postmortem_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"owner" text,
	"tracker_url" text,
	"state" text DEFAULT 'open' NOT NULL,
	"due_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"generated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postmortem_action_items_type_vocabulary" CHECK (type in ('prevent', 'mitigate', 'process')),
	CONSTRAINT "postmortem_action_items_state_vocabulary" CHECK (state in ('open', 'in_progress', 'done', 'wont_do')),
	CONSTRAINT "postmortem_action_items_title_not_blank" CHECK (btrim("postmortem_action_items"."title") <> ''),
	CONSTRAINT "postmortem_action_items_tracker_https" CHECK ("postmortem_action_items"."tracker_url" is null or "postmortem_action_items"."tracker_url" like 'https://%'),
	CONSTRAINT "postmortem_action_items_completion_shape" CHECK (("postmortem_action_items"."state" in ('done', 'wont_do')) = ("postmortem_action_items"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "postmortem_action_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "postmortems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger" text NOT NULL,
	"summary" text NOT NULL,
	"impact" text NOT NULL,
	"contributing_causes" jsonb NOT NULL,
	"trigger_narrative" text NOT NULL,
	"resolution" text NOT NULL,
	"detection" text NOT NULL,
	"lessons" jsonb NOT NULL,
	"timeline" jsonb NOT NULL,
	"supporting_information" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"assessment_run_id" uuid,
	"requested_by_user_id" uuid,
	"published_by_user_id" uuid,
	"published_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "postmortems_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "postmortems_incident_uq" UNIQUE("tenant_id","incident_id"),
	CONSTRAINT "postmortems_status_vocabulary" CHECK (status in ('draft', 'published')),
	CONSTRAINT "postmortems_trigger_vocabulary" CHECK (trigger in ('user_visible_impact', 'data_loss', 'oncall_intervention', 'slow_resolution', 'monitoring_failure')),
	CONSTRAINT "postmortems_publish_shape" CHECK (("postmortems"."status" = 'published') = ("postmortems"."published_at" is not null and "postmortems"."published_by_user_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "postmortems" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "assessment_grades" ADD CONSTRAINT "assessment_grades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_grades" ADD CONSTRAINT "assessment_grades_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_grades" ADD CONSTRAINT "assessment_grades_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."investigation_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessment_grades" ADD CONSTRAINT "assessment_grades_membership_fk" FOREIGN KEY ("graded_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortem_action_items" ADD CONSTRAINT "postmortem_action_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortem_action_items" ADD CONSTRAINT "postmortem_action_items_postmortem_fk" FOREIGN KEY ("tenant_id","postmortem_id") REFERENCES "public"."postmortems"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "postmortems" ADD CONSTRAINT "postmortems_publisher_fk" FOREIGN KEY ("published_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_grades_run_uq" ON "assessment_grades" USING btree ("tenant_id","run_id");--> statement-breakpoint
CREATE INDEX "assessment_grades_calibration_idx" ON "assessment_grades" USING btree ("tenant_id","claimed_confidence","created_at");--> statement-breakpoint
CREATE INDEX "postmortem_action_items_state_idx" ON "postmortem_action_items" USING btree ("tenant_id","state","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_postmortem_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'incidentId')) WHERE type = 'postmortem.generate' AND status IN ('queued','processing');--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_assessment_grade_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'incidentId')) WHERE type = 'assessment.grade' AND status IN ('queued','processing');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "assessment_grades" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "postmortem_action_items" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "postmortems" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);