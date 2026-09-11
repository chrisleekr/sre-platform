CREATE TABLE "entity_service_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"candidate_key" text NOT NULL,
	"candidate_kind" text NOT NULL,
	"service_name" text NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"confirmed_by_user_id" uuid NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_service_mappings_candidate_uq" UNIQUE("tenant_id","candidate_key"),
	CONSTRAINT "entity_service_mappings_source_vocabulary" CHECK ("entity_service_mappings"."source" = 'human'),
	CONSTRAINT "entity_service_mappings_rationale_not_blank" CHECK (btrim("entity_service_mappings"."rationale") <> '')
);
--> statement-breakpoint
ALTER TABLE "entity_service_mappings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "signal_source" jsonb;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "affected_entities" jsonb;--> statement-breakpoint
ALTER TABLE "entity_service_mappings" ADD CONSTRAINT "entity_service_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_service_mappings" ADD CONSTRAINT "entity_service_mappings_membership_fk" FOREIGN KEY ("confirmed_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_service_mappings" ADD CONSTRAINT "entity_service_mappings_service_fk" FOREIGN KEY ("tenant_id","service_name") REFERENCES "public"."services"("tenant_id","name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_service_mappings_service_idx" ON "entity_service_mappings" USING btree ("tenant_id","service_name");--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_signal_source_shape" CHECK ("incident_signals"."signal_source" is null or jsonb_typeof("incident_signals"."signal_source") = 'object');--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_affected_entities_shape" CHECK ("incident_signals"."affected_entities" is null or jsonb_typeof("incident_signals"."affected_entities") = 'array');--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "entity_service_mappings" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
