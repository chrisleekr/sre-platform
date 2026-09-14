CREATE TABLE "service_runtime_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_name" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"label_key" text DEFAULT '' NOT NULL,
	"label_value" text DEFAULT '' NOT NULL,
	"environment" text NOT NULL,
	"confirmed_by_user_id" uuid NOT NULL,
	"rationale" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_runtime_binding_scope_uq" UNIQUE("tenant_id","connector_id","namespace","label_key","label_value"),
	CONSTRAINT "runtime_binding_nonempty" CHECK (btrim(namespace) <> '' and btrim(environment) <> '' and btrim(rationale) <> ''),
	CONSTRAINT "runtime_binding_label_pair" CHECK ((label_key = '' and label_value = '') or (btrim(label_key) <> '' and btrim(label_value) <> ''))
);
--> statement-breakpoint
ALTER TABLE "service_runtime_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_runtime_bindings" ADD CONSTRAINT "service_runtime_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_runtime_bindings" ADD CONSTRAINT "runtime_binding_service_fk" FOREIGN KEY ("tenant_id","service_name") REFERENCES "public"."services"("tenant_id","name") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_runtime_bindings" ADD CONSTRAINT "runtime_binding_connector_fk" FOREIGN KEY ("tenant_id","connector_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_runtime_bindings" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);