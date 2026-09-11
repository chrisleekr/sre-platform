ALTER TABLE "incidents" ADD COLUMN "current_state" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "impact" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "assessment_evidence_ids" uuid[];--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_evidence_ids" uuid[];--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_unknowns" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_next_step" text;
