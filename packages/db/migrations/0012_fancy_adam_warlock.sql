CREATE TABLE "github_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"repository_id" text,
	"repository_full_name" text,
	"actor" text,
	"ref" text,
	"sha" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_events_delivery_uq" UNIQUE("tenant_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "github_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "github_manifest_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"owner_type" text NOT NULL,
	"organization" text,
	"webhook_url" text NOT NULL,
	"redirect_url" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_manifest_sessions_state_uq" UNIQUE("tenant_id","state_hash")
);
--> statement-breakpoint
ALTER TABLE "github_manifest_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "github_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"installation_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"html_url" text NOT NULL,
	"pushed_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_repositories_provider_uq" UNIQUE("tenant_id","repository_id")
);
--> statement-breakpoint
ALTER TABLE "github_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "service_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service" text NOT NULL,
	"provider" text NOT NULL,
	"repository_full_name" text NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_repositories_mapping_uq" UNIQUE("tenant_id","service","provider","repository_full_name","path")
);
--> statement-breakpoint
ALTER TABLE "service_repositories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "webhook_key" uuid;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "event_attempted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "event_succeeded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "event_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "event_failure_category" text;--> statement-breakpoint
ALTER TABLE "github_events" ADD CONSTRAINT "github_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_manifest_sessions" ADD CONSTRAINT "github_manifest_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_repositories" ADD CONSTRAINT "service_repositories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_events_repository_time_idx" ON "github_events" USING btree ("tenant_id","repository_full_name","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "github_events_type_time_idx" ON "github_events" USING btree ("tenant_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "github_manifest_sessions_expiry_idx" ON "github_manifest_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_active_name_uq" ON "github_repositories" USING btree ("tenant_id","full_name") WHERE "github_repositories"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "github_repositories_installation_idx" ON "github_repositories" USING btree ("tenant_id","installation_id","removed_at");--> statement-breakpoint
CREATE INDEX "github_repositories_lookup_idx" ON "github_repositories" USING btree ("tenant_id","name","removed_at");--> statement-breakpoint
CREATE INDEX "service_repositories_service_idx" ON "service_repositories" USING btree ("tenant_id","service","provider");--> statement-breakpoint
ALTER TABLE "connector_configs" ADD CONSTRAINT "connector_configs_webhook_key_unique" UNIQUE("webhook_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "github_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "github_manifest_sessions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "github_repositories" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_repositories" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);