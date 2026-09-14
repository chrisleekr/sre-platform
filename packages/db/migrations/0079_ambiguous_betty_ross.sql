CREATE TABLE "service_dependency_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"upstream" text NOT NULL,
	"downstream" text NOT NULL,
	"environment" text DEFAULT '' NOT NULL,
	"declaration" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "service_dependency_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "service_dependencies" DROP CONSTRAINT "service_deps_edge_uq";--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD COLUMN "environment" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD COLUMN "rationale" text;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD COLUMN "confirmed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD COLUMN "last_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "service_dependency_history" ADD CONSTRAINT "service_dependency_history_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_dependency_history_time_idx" ON "service_dependency_history" USING btree ("tenant_id","valid_from");--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_deps_edge_uq" UNIQUE("tenant_id","upstream","downstream","environment");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "service_dependency_history" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
--> statement-breakpoint
-- Begin recorded history now, without inventing past confirmations for existing declarations.
DO $$
DECLARE workspace_id uuid;
DECLARE previous_scope text := current_setting('app.tenant_id', true);
BEGIN
  FOR workspace_id IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', workspace_id::text, true);
    INSERT INTO service_dependency_history (tenant_id, upstream, downstream, environment, declaration)
    SELECT tenant_id, upstream, downstream, environment,
      jsonb_build_object('syncType', sync_type, 'circuitBreaker', circuit_breaker, 'protocol', protocol,
        'rationale', null, 'confirmedByUserId', null, 'lastConfirmedAt', null)
    FROM service_dependencies WHERE tenant_id = workspace_id;
  END LOOP;
  PERFORM set_config('app.tenant_id', coalesce(previous_scope, ''), true);
END $$;
