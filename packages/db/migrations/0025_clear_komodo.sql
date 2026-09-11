CREATE TABLE "investigation_subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"source_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"source_path" text NOT NULL,
	"captured_state" text NOT NULL,
	"captured_summary" text NOT NULL,
	"captured_snapshot" jsonb NOT NULL,
	"captured_hash" text NOT NULL,
	"observed_at" timestamp (3) with time zone NOT NULL,
	"current_state" text NOT NULL,
	"current_summary" text NOT NULL,
	"current_snapshot" jsonb NOT NULL,
	"current_hash" text NOT NULL,
	"last_synced_at" timestamp (3) with time zone NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "investigation_subjects_incident_uq" UNIQUE("tenant_id","incident_id"),
	CONSTRAINT "investigation_subjects_kind_vocabulary" CHECK (kind in ('infrastructure_resource', 'deployment', 'connector_verification', 'topology_service')),
	CONSTRAINT "investigation_subjects_captured_state_vocabulary" CHECK (captured_state in ('firing', 'unknown', 'resolved')),
	CONSTRAINT "investigation_subjects_current_state_vocabulary" CHECK (current_state in ('firing', 'unknown', 'resolved'))
);
--> statement-breakpoint
ALTER TABLE "investigation_subjects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "investigation_subjects" ADD CONSTRAINT "investigation_subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_subjects" ADD CONSTRAINT "investigation_subjects_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_subjects_fingerprint_idx" ON "investigation_subjects" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "investigation_subjects_identity_idx" ON "investigation_subjects" USING btree ("tenant_id","kind","source_id","subject_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "investigation_subjects" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);