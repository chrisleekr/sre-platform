CREATE TABLE "knowledge_capture_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"offer_message_id" uuid NOT NULL,
	"fence_message_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"consumed_message_id" uuid,
	"expires_at" timestamp with time zone DEFAULT now() + interval '15 minutes' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_capture_proposals_source_uq" UNIQUE("tenant_id","source_message_id")
);
--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_source_fk" FOREIGN KEY ("tenant_id","source_message_id") REFERENCES "public"."incident_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_offer_fk" FOREIGN KEY ("tenant_id","offer_message_id") REFERENCES "public"."incident_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_capture_proposals" ADD CONSTRAINT "knowledge_capture_proposals_fence_fk" FOREIGN KEY ("tenant_id","fence_message_id") REFERENCES "public"."incident_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_capture_proposals_pending_idx" ON "knowledge_capture_proposals" USING btree ("tenant_id","incident_id","status");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "knowledge_capture_proposals" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);