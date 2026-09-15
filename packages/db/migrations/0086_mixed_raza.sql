CREATE TABLE "issue_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_version" integer NOT NULL,
	"repository" text NOT NULL,
	"repository_id" text NOT NULL,
	"destination" jsonb NOT NULL,
	"number" integer,
	"requested_by" uuid NOT NULL,
	"request_key" text NOT NULL,
	"changes" jsonb NOT NULL,
	"before" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"result" jsonb,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_actions_request_uq" UNIQUE("tenant_id","incident_id","request_key")
);
--> statement-breakpoint
ALTER TABLE "issue_actions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "issue_actions" ADD CONSTRAINT "issue_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_actions" ADD CONSTRAINT "issue_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_actions" ADD CONSTRAINT "issue_actions_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_actions_incident_idx" ON "issue_actions" USING btree ("tenant_id","incident_id","created_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "issue_actions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);