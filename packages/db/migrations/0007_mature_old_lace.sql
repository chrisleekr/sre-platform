CREATE TABLE "surface_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"operation" text DEFAULT 'composite' NOT NULL,
	"remote_message_id" text,
	"reason_code" text,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"attempted_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surface_deliveries_message_surface_uq" UNIQUE("tenant_id","surface","message_id"),
	CONSTRAINT "surface_deliveries_state_vocabulary" CHECK (state in ('queued', 'sending', 'accepted', 'rejected', 'uncertain', 'blocked', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "surface_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ALTER COLUMN "created_at" SET DATA TYPE timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "unknowns" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "next_step" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "assessment_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."incident_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surface_deliveries_queued_idx" ON "surface_deliveries" USING btree ("state","next_attempt_at","created_at","id");--> statement-breakpoint
CREATE INDEX "agent_tool_calls_incident_created_id_idx" ON "agent_tool_calls" USING btree ("incident_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "surface_deliveries" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
