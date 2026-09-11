CREATE TABLE "investigation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"provider" text,
	"engine_model" text,
	"engine_session_id" text,
	"turn_budget" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"result" jsonb,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "investigation_runs_tenant_incident_id_uq" UNIQUE("tenant_id","incident_id","id"),
	CONSTRAINT "investigation_runs_operation_vocabulary" CHECK (operation in ('investigate', 'reassess', 'resume', 'verify-recovery')),
	CONSTRAINT "investigation_runs_outcome_vocabulary" CHECK (outcome in ('conclusive', 'inconclusive', 'blocked_missing_capability', 'budget_exhausted', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "investigation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "trusted_assessment_run_id" uuid;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_runs_incident_started_idx" ON "investigation_runs" USING btree ("tenant_id","incident_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_trusted_assessment_run_fk" FOREIGN KEY ("tenant_id","id","trusted_assessment_run_id") REFERENCES "public"."investigation_runs"("tenant_id","incident_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "investigation_runs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_completion_shape" CHECK ((("investigation_runs"."outcome" is null and "investigation_runs"."result" is null and "investigation_runs"."completed_at" is null) or ("investigation_runs"."outcome" is not null and "investigation_runs"."result" is not null and "investigation_runs"."completed_at" is not null)));
--> statement-breakpoint
CREATE FUNCTION prevent_investigation_run_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF current_user = 'app_user' THEN
			RAISE EXCEPTION 'investigation runs cannot be deleted by the application role' USING ERRCODE = '55000';
		END IF;
		RETURN OLD;
	END IF;
	IF current_user = 'app_user' AND OLD.completed_at IS NOT NULL THEN
		RAISE EXCEPTION 'completed investigation runs are immutable' USING ERRCODE = '55000';
	END IF;
	IF current_user = 'app_user' AND (NEW.id IS DISTINCT FROM OLD.id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
		OR NEW.operation IS DISTINCT FROM OLD.operation
		OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
		RAISE EXCEPTION 'investigation run identity is immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER investigation_runs_immutable
BEFORE UPDATE OR DELETE ON investigation_runs
FOR EACH ROW EXECUTE FUNCTION prevent_investigation_run_mutation();
