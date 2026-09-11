ALTER TABLE "surface_inbound_events" ADD COLUMN "classification_outcome" text;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD COLUMN "classification_updated_at" timestamp (3) with time zone;--> statement-breakpoint
UPDATE "surface_inbound_events"
SET
  "classification_outcome" = 'legacy_unobserved',
  "classification_updated_at" = COALESCE("completed_at", "updated_at")
WHERE "outcome" IN ('classify_enqueued', 'mention_enqueued', 'edit_enqueued');
