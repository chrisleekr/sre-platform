CREATE TABLE "surface_inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"config_id" uuid,
	"job_id" uuid,
	"surface" text NOT NULL,
	"delivery_key" text NOT NULL,
	"envelope_type" text NOT NULL,
	"event_type" text,
	"event_subtype" text,
	"channel" text,
	"state" text NOT NULL,
	"outcome" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"accepted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "surface_inbound_events_delivery_uq" UNIQUE("surface","delivery_key"),
	CONSTRAINT "surface_inbound_events_state_vocabulary" CHECK (state in ('queued', 'processing', 'processed', 'retrying', 'dropped'))
);
--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD CONSTRAINT "surface_inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD CONSTRAINT "surface_inbound_events_config_id_surface_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."surface_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD CONSTRAINT "surface_inbound_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surface_inbound_events_tenant_recent_idx" ON "surface_inbound_events" USING btree ("tenant_id","surface","accepted_at");--> statement-breakpoint
CREATE INDEX "surface_inbound_events_state_idx" ON "surface_inbound_events" USING btree ("state","updated_at");