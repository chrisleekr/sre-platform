CREATE TABLE "gitlab_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"action" text,
	"project_id" text,
	"project_full_path" text,
	"actor" text,
	"ref" text,
	"sha" text,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gitlab_events_delivery_uq" UNIQUE("tenant_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "gitlab_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gitlab_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"full_path" text NOT NULL,
	"default_branch" text,
	"visibility" text,
	"archived" boolean DEFAULT false NOT NULL,
	"web_url" text NOT NULL,
	"last_activity_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gitlab_projects_provider_uq" UNIQUE("tenant_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "gitlab_projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gitlab_events" ADD CONSTRAINT "gitlab_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD CONSTRAINT "gitlab_projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gitlab_events_project_time_idx" ON "gitlab_events" USING btree ("tenant_id","project_full_path","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "gitlab_events_type_time_idx" ON "gitlab_events" USING btree ("tenant_id","event_type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_projects_active_path_uq" ON "gitlab_projects" USING btree ("tenant_id","full_path") WHERE "gitlab_projects"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "gitlab_projects_group_idx" ON "gitlab_projects" USING btree ("tenant_id","group_id","removed_at");--> statement-breakpoint
CREATE INDEX "gitlab_projects_lookup_idx" ON "gitlab_projects" USING btree ("tenant_id","name","removed_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gitlab_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gitlab_projects" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);