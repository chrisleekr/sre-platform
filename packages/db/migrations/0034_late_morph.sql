ALTER TABLE "surface_inbound_events" ADD COLUMN "external_message_id" text;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD COLUMN "terminal_disposition" text;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD COLUMN "terminal_disposition_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "surface_inbound_events_message_idx" ON "surface_inbound_events" USING btree ("tenant_id","surface","channel","external_message_id");