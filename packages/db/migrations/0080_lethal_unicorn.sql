CREATE TABLE "incident_service_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"confirmed_by_user_id" uuid NOT NULL,
	"rationale" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_service_assignment_uq" UNIQUE("tenant_id","incident_id","service_name")
);
--> statement-breakpoint
ALTER TABLE "incident_service_assignments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_service_assignments" ADD CONSTRAINT "incident_service_assignments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_service_assignments" ADD CONSTRAINT "incident_service_assignment_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_service_assignments" ADD CONSTRAINT "incident_service_assignment_service_fk" FOREIGN KEY ("tenant_id","service_name") REFERENCES "public"."services"("tenant_id","name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_service_assignments" ADD CONSTRAINT "incident_service_assignment_actor_fk" FOREIGN KEY ("confirmed_by_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_service_assignments" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);