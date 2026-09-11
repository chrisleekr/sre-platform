CREATE TABLE "incident_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"channel" text NOT NULL,
	"external_message_id" text NOT NULL,
	"state" text NOT NULL,
	"last_event_type" text NOT NULL,
	"summary" text NOT NULL,
	"content_hash" text NOT NULL,
	"last_event_key" text NOT NULL,
	"last_event_at" timestamp (3) with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp (3) with time zone,
	CONSTRAINT "incident_signals_external_uq" UNIQUE("tenant_id","surface","channel","external_message_id"),
	CONSTRAINT "incident_signals_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_signals_state_vocabulary" CHECK (state in ('firing', 'unknown', 'resolved')),
	CONSTRAINT "incident_signals_event_type_vocabulary" CHECK (last_event_type in ('opened', 'updated', 'resolved', 'refired'))
);
--> statement-breakpoint
ALTER TABLE "incident_signals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT "incidents_status_vocabulary";--> statement-breakpoint
DROP INDEX "incidents_active_fingerprint_uq";--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "investigation_status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "acknowledged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "mitigated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "lifecycle_from" text;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "lifecycle_to" text;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "lifecycle_version" integer;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "transition_key" text;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "signal_id" uuid;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "signal_state" text;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD COLUMN "signal_event_type" text;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "status_message_id" text;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "status_message_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "incidents"
SET "investigation_status" = CASE "status"
	WHEN 'investigating' THEN CASE WHEN "rca_summary" IS NULL THEN 'gathering' ELSE 'assessed' END
	WHEN 'degraded' THEN 'degraded'
	WHEN 'resolved' THEN CASE WHEN "rca_summary" IS NULL THEN 'queued' ELSE 'assessed' END
	WHEN 'closed' THEN CASE WHEN "rca_summary" IS NULL THEN 'queued' ELSE 'assessed' END
	ELSE 'queued'
END;--> statement-breakpoint
UPDATE "incidents"
SET "closed_at" = COALESCE("closed_at", "updated_at")
WHERE "status" = 'closed';--> statement-breakpoint
UPDATE "incidents"
SET "status" = 'open'
WHERE "status" IN ('investigating', 'degraded');--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_signals_incident_state_idx" ON "incident_signals" USING btree ("tenant_id","incident_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_active_fingerprint_uq" ON "incidents" USING btree ("tenant_id","fingerprint") WHERE status in ('open', 'acknowledged', 'mitigated');--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_transition_uq" UNIQUE("tenant_id","transition_key");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_investigation_status_vocabulary" CHECK (investigation_status in ('queued', 'gathering', 'assessed', 'degraded'));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_status_vocabulary" CHECK (status in ('open', 'acknowledged', 'mitigated', 'resolved', 'closed'));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_signals" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
