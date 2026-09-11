CREATE TABLE "gitlab_hook_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"lifecycle_version" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"catalog_page" integer DEFAULT 1 NOT NULL,
	"catalog_checked_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"failure_category" text
);
--> statement-breakpoint
ALTER TABLE "gitlab_hook_authorizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "gitlab_managed_hooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"project_id" text NOT NULL,
	"project_path" text NOT NULL,
	"ownership_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"hook_id" text,
	"scan_page" integer DEFAULT 1 NOT NULL,
	"create_attempted_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"succeeded_at" timestamp with time zone,
	"applied_authorization_id" uuid,
	"removed" boolean DEFAULT false NOT NULL,
	"failure_category" text
);
--> statement-breakpoint
ALTER TABLE "gitlab_managed_hooks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "gitlab_hook_authorizations" ADD CONSTRAINT "gitlab_hook_authorizations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_managed_hooks" ADD CONSTRAINT "gitlab_managed_hooks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_hook_authorization_connector_uq" ON "gitlab_hook_authorizations" USING btree ("tenant_id","connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_managed_hook_project_uq" ON "gitlab_managed_hooks" USING btree ("tenant_id","connector_id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_managed_hook_ownership_uq" ON "gitlab_managed_hooks" USING btree ("tenant_id","ownership_id");--> statement-breakpoint
CREATE INDEX "gitlab_managed_hook_work_idx" ON "gitlab_managed_hooks" USING btree ("tenant_id","connector_id","removed","attempted_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gitlab_hook_authorizations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "gitlab_managed_hooks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);