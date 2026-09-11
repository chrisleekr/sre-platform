CREATE TABLE "incident_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"decision" text NOT NULL,
	"rationale" text NOT NULL,
	"correction" jsonb,
	"created_by_user_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_feedback_target_decision_vocabulary" CHECK ((
        ("incident_feedback"."target_type" = 'finding' and "incident_feedback"."decision" in ('confirm', 'correct'))
        or ("incident_feedback"."target_type" = 'entity' and "incident_feedback"."decision" in ('confirm', 'correct'))
        or ("incident_feedback"."target_type" = 'correlation' and "incident_feedback"."decision" in ('group', 'separate'))
        or ("incident_feedback"."target_type" = 'noise' and "incident_feedback"."decision" in ('noise', 'not_noise'))
      )),
	CONSTRAINT "incident_feedback_target_not_blank" CHECK (btrim("incident_feedback"."target_id") <> ''),
	CONSTRAINT "incident_feedback_rationale_not_blank" CHECK (btrim("incident_feedback"."rationale") <> '')
);
--> statement-breakpoint
ALTER TABLE "incident_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "finding" jsonb;--> statement-breakpoint
ALTER TABLE "incident_feedback" ADD CONSTRAINT "incident_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_feedback" ADD CONSTRAINT "incident_feedback_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_feedback" ADD CONSTRAINT "incident_feedback_membership_fk" FOREIGN KEY ("created_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_feedback_incident_created_idx" ON "incident_feedback" USING btree ("tenant_id","incident_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_feedback_actor_created_idx" ON "incident_feedback" USING btree ("tenant_id","created_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "incident_feedback_target_idx" ON "incident_feedback" USING btree ("tenant_id","target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_feedback_target_revision_uq" ON "incident_feedback" USING btree ("tenant_id","target_type","target_id","revision");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_feedback" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
