ALTER TABLE "incidents" ADD COLUMN "recovery_questions" jsonb;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_questions_updated_at" timestamp with time zone;