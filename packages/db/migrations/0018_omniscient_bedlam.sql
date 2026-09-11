CREATE TABLE "alert_cohort_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"joined_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_cohort_members_signal_uq" UNIQUE("tenant_id","signal_id")
);
--> statement-breakpoint
ALTER TABLE "alert_cohort_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alert_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"data_source_id" uuid NOT NULL,
	"anchor_signal_id" uuid NOT NULL,
	"state" text DEFAULT 'collecting' NOT NULL,
	"window_started_at" timestamp (3) with time zone NOT NULL,
	"window_ends_at" timestamp (3) with time zone NOT NULL,
	"last_alert_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_cohorts_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "alert_cohorts_state_vocabulary" CHECK (state in ('collecting', 'settled')),
	CONSTRAINT "alert_cohorts_window_order" CHECK (window_ends_at >= window_started_at)
);
--> statement-breakpoint
ALTER TABLE "alert_cohorts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "alert_episode_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"data_source_id" uuid NOT NULL,
	"provider_fingerprint" text NOT NULL,
	"starts_at" timestamp (3) with time zone NOT NULL,
	"material_hash" text NOT NULL,
	"observation" jsonb NOT NULL,
	"channel" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"root_message_id" text,
	"incident_id" uuid,
	"binding_id" uuid,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"failure_category" text,
	"first_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_episode_intakes_episode_uq" UNIQUE("tenant_id","data_source_id","provider_fingerprint","starts_at"),
	CONSTRAINT "alert_episode_intakes_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "alert_episode_intakes_state_vocabulary" CHECK (state in ('pending', 'posting', 'posted', 'accepted', 'rejected', 'uncertain')),
	CONSTRAINT "alert_episode_intakes_root_state" CHECK ((state in ('pending', 'posting', 'rejected', 'uncertain') and root_message_id is null) or (state in ('posted', 'accepted') and root_message_id is not null)),
	CONSTRAINT "alert_episode_intakes_acceptance" CHECK (state <> 'accepted' or (incident_id is not null and binding_id is not null))
);
--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incident_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_incident_id" uuid NOT NULL,
	"target_incident_id" uuid NOT NULL,
	"type" text NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"correction" jsonb,
	"decided_by" text NOT NULL,
	"decided_by_user_id" uuid,
	"superseded_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_relations_type_vocabulary" CHECK (type in ('possible_related', 'recurrence_of', 'merged_into', 'split_from', 'unrelated')),
	CONSTRAINT "incident_relations_decider_vocabulary" CHECK (decided_by in ('system', 'agent', 'human')),
	CONSTRAINT "incident_relations_distinct_incidents" CHECK (source_incident_id <> target_incident_id)
);
--> statement-breakpoint
ALTER TABLE "incident_relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT "surface_bindings_incident_uq";--> statement-breakpoint
ALTER TABLE "surface_deliveries" DROP CONSTRAINT "surface_deliveries_message_surface_uq";--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "data_source_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "provider_fingerprint" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "provider_group_key" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "alert_name" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "starts_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "ends_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "labels" jsonb;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "annotations" jsonb;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "generator_url" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "material_hash" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "last_investigated_material_hash" text;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "role" text DEFAULT 'primary' NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "projection_mode" text DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD COLUMN "binding_id" uuid;--> statement-breakpoint
UPDATE "surface_deliveries" AS delivery
SET "binding_id" = binding."id"
FROM "surface_bindings" AS binding
WHERE binding."tenant_id" = delivery."tenant_id"
	AND binding."incident_id" = delivery."incident_id"
	AND binding."surface" = delivery."surface";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "surface_deliveries" WHERE "binding_id" IS NULL) THEN
		RAISE EXCEPTION 'surface delivery has no matching incident binding';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ALTER COLUMN "binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD CONSTRAINT "connector_configs_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_tenant_id_uq" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "alert_cohort_members" ADD CONSTRAINT "alert_cohort_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohort_members" ADD CONSTRAINT "alert_cohort_members_cohort_fk" FOREIGN KEY ("tenant_id","cohort_id") REFERENCES "public"."alert_cohorts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohort_members" ADD CONSTRAINT "alert_cohort_members_signal_fk" FOREIGN KEY ("tenant_id","signal_id") REFERENCES "public"."incident_signals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_data_source_fk" FOREIGN KEY ("tenant_id","data_source_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_anchor_signal_fk" FOREIGN KEY ("tenant_id","anchor_signal_id") REFERENCES "public"."incident_signals"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_data_source_fk" FOREIGN KEY ("tenant_id","data_source_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."surface_bindings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_source_fk" FOREIGN KEY ("tenant_id","source_incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_target_fk" FOREIGN KEY ("tenant_id","target_incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_cohort_members_cohort_idx" ON "alert_cohort_members" USING btree ("tenant_id","cohort_id","joined_at");--> statement-breakpoint
CREATE INDEX "alert_cohorts_collecting_idx" ON "alert_cohorts" USING btree ("tenant_id","data_source_id","state","window_ends_at");--> statement-breakpoint
CREATE INDEX "alert_episode_intakes_state_idx" ON "alert_episode_intakes" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_relations_active_uq" ON "incident_relations" USING btree ("tenant_id","source_incident_id","target_incident_id","type") WHERE "incident_relations"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "incident_relations_target_idx" ON "incident_relations" USING btree ("tenant_id","target_incident_id","created_at");--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_data_source_fk" FOREIGN KEY ("tenant_id","data_source_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."surface_bindings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_signals_provider_episode_uq" ON "incident_signals" USING btree ("tenant_id","data_source_id","provider_fingerprint","starts_at") WHERE "incident_signals"."data_source_id" is not null and "incident_signals"."provider_fingerprint" is not null and "incident_signals"."starts_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "surface_bindings_primary_uq" ON "surface_bindings" USING btree ("tenant_id","surface","incident_id") WHERE "surface_bindings"."role" = 'primary';--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_message_binding_uq" UNIQUE("tenant_id","message_id","binding_id");--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_role_vocabulary" CHECK (role in ('primary', 'source'));--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_projection_vocabulary" CHECK (projection_mode in ('full', 'status'));--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_role_projection" CHECK ((role = 'primary' and projection_mode = 'full') or (role = 'source' and projection_mode = 'status'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "alert_cohort_members" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "alert_cohorts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "alert_episode_intakes" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_relations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
