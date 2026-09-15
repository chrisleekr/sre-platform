CREATE TABLE "topology_collections" (
	"tenant_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"key" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"completeness" text NOT NULL,
	"issue" text,
	"entities" jsonb NOT NULL,
	"relations" jsonb NOT NULL,
	CONSTRAINT "topology_collections_tenant_id_connector_id_key_pk" PRIMARY KEY("tenant_id","connector_id","key")
);
--> statement-breakpoint
ALTER TABLE "topology_collections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "topology_collections" ADD CONSTRAINT "topology_collection_connector_fk" FOREIGN KEY ("tenant_id","connector_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "topology_collections" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);