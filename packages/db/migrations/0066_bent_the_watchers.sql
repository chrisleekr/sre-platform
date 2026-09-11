CREATE TABLE "slo_burn_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slo_id" uuid NOT NULL,
	"budget_pct" double precision NOT NULL,
	"burn_rate" double precision NOT NULL,
	"window" text NOT NULL,
	"computed_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slo_burn_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"service" text NOT NULL,
	"sli_type" text NOT NULL,
	"target" double precision NOT NULL,
	"window_days" integer NOT NULL,
	"threshold_ms" integer,
	"metric_query" text NOT NULL,
	"connector_type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slos_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "slos_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "slos_sli_type_ck" CHECK (sli_type in ('availability', 'latency')),
	CONSTRAINT "slos_target_range_ck" CHECK (target > 0 and target < 1),
	CONSTRAINT "slos_window_days_ck" CHECK (window_days > 0),
	CONSTRAINT "slos_latency_threshold_ck" CHECK ((sli_type = 'latency') = (threshold_ms is not null))
);
--> statement-breakpoint
ALTER TABLE "slos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "budget_remaining" double precision;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "high_risk" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "slo_burn_events" ADD CONSTRAINT "slo_burn_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slo_burn_events" ADD CONSTRAINT "slo_burn_events_slo_fk" FOREIGN KEY ("tenant_id","slo_id") REFERENCES "public"."slos"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slos" ADD CONSTRAINT "slos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "slo_burn_events_lookup_idx" ON "slo_burn_events" USING btree ("tenant_id","slo_id","computed_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slo_burn_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slos" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);