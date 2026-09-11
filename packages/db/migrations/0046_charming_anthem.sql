CREATE TABLE "signal_disposition_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"corpus_version" text NOT NULL,
	"contract_version" text NOT NULL,
	"runtime_fingerprint" text NOT NULL,
	"total" integer,
	"correct" integer,
	"critical_safety_misses" integer,
	"class_metrics" jsonb,
	"failure_category" text,
	"requested_by_user_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_disposition_evaluations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "signal_disposition_evaluations_status" CHECK (status in ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "signal_disposition_evaluations_result_shape" CHECK ((
        status <> 'completed'
        or (
          total is not null and total > 0
          and correct is not null and correct between 0 and total
          and critical_safety_misses is not null and critical_safety_misses >= 0
          and class_metrics is not null
          and completed_at is not null
        )
      )),
	CONSTRAINT "signal_disposition_evaluations_failure_shape" CHECK (status <> 'failed' or (failure_category is not null and completed_at is not null))
);
--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" DROP CONSTRAINT "tenant_signal_policies_corpus_misses";--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" DROP CONSTRAINT "tenant_signal_policies_enforcement";--> statement-breakpoint
ALTER TABLE "signal_dispositions" DROP CONSTRAINT "signal_dispositions_promoted_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" DROP CONSTRAINT "tenant_signal_policies_approved_by_fk";
--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD COLUMN "approved_evaluation_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD COLUMN "approved_corpus_version" text;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD COLUMN "approved_contract_version" text;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD COLUMN "approved_runtime_fingerprint" text;--> statement-breakpoint
UPDATE "tenant_signal_policies" SET "classification_mode" = 'shadow' WHERE "classification_mode" = 'enforce';--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_requester_membership_fk" FOREIGN KEY ("requested_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_disposition_evaluations_recent_idx" ON "signal_disposition_evaluations" USING btree ("tenant_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_promoter_membership_fk" FOREIGN KEY ("promoted_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_approved_evaluation_fk" FOREIGN KEY ("tenant_id","approved_evaluation_id") REFERENCES "public"."signal_disposition_evaluations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_approved_by_fk" FOREIGN KEY ("enforcement_approved_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" DROP COLUMN "corpus_critical_safety_misses";--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_enforcement" CHECK (classification_mode <> 'enforce' or (
        enforcement_approved_at is not null
        and enforcement_approved_by_user_id is not null
        and approved_evaluation_id is not null
        and approved_corpus_version is not null
        and approved_contract_version is not null
        and approved_runtime_fingerprint is not null
      ));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "signal_disposition_evaluations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
