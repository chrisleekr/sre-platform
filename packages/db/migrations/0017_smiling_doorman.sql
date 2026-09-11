CREATE TABLE "platform_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid,
	"job_id" uuid,
	"operation" text NOT NULL,
	"runtime" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"config" jsonb NOT NULL,
	"pricing" jsonb,
	"config_updated_at" timestamp with time zone,
	"status" text DEFAULT 'running' NOT NULL,
	"error_category" text,
	"request_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"usage_reported" boolean DEFAULT false NOT NULL,
	"configured_cost_usd" numeric(24, 12),
	"provider_estimated_cost_usd" numeric(24, 12),
	"telemetry_complete" boolean,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "llm_invocations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "llm_invocations_status_vocabulary" CHECK (status in ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "llm_invocations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "llm_telemetry_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider_sequence" integer,
	"provider_timestamp" timestamp (3) with time zone,
	"model" text,
	"payload" jsonb NOT NULL,
	"body_bytes" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_telemetry_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry_events" ADD CONSTRAINT "llm_telemetry_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry_events" ADD CONSTRAINT "llm_telemetry_events_invocation_fk" FOREIGN KEY ("tenant_id","invocation_id") REFERENCES "public"."llm_invocations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_invocations_started_idx" ON "llm_invocations" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_invocations_tenant_started_idx" ON "llm_invocations" USING btree ("tenant_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_invocations_incident_started_idx" ON "llm_invocations" USING btree ("incident_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_telemetry_events_invocation_sequence_idx" ON "llm_telemetry_events" USING btree ("invocation_id","provider_sequence","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "llm_invocations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "llm_telemetry_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);