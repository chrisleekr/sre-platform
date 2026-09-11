ALTER TABLE "signal_disposition_evaluations" DROP CONSTRAINT "signal_disposition_evaluations_result_shape";--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" DROP CONSTRAINT "incident_tag_suggestions_applied_tag_fk";
--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD COLUMN "scenario_results" jsonb;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD COLUMN "ticket_semantics_reviewed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD COLUMN "ticket_semantics_reviewed_by_user_id" uuid;--> statement-breakpoint
UPDATE "tenant_signal_policies"
SET "classification_mode" = 'shadow', "updated_at" = now()
WHERE "classification_mode" = 'enforce';--> statement-breakpoint
UPDATE "signal_disposition_evaluations"
SET "status" = 'failed', "failure_category" = 'contract_migrated', "completed_at" = coalesce("completed_at", now())
WHERE "status" = 'completed' AND "scenario_results" IS NULL;--> statement-breakpoint
UPDATE "incident_tag_suggestions" AS suggestion
SET "applied_tag_id" = NULL
FROM "incident_tags" AS tag
WHERE suggestion."applied_tag_id" = tag."id"
  AND suggestion."tenant_id" <> tag."tenant_id";--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_applied_tag_fk" FOREIGN KEY ("tenant_id","applied_tag_id") REFERENCES "public"."incident_tags"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_reviewer_membership_fk" FOREIGN KEY ("ticket_semantics_reviewed_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_result_shape" CHECK ((
        status <> 'completed'
        or (
          total is not null and total > 0
          and correct is not null and correct between 0 and total
          and critical_safety_misses is not null and critical_safety_misses >= 0
          and class_metrics is not null
          and scenario_results is not null
          and completed_at is not null
        )
      ));
