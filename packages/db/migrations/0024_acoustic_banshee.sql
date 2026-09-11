ALTER TABLE "incidents" DROP CONSTRAINT "incidents_recovery_state_vocabulary";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_attempt" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_max_checks" integer;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_schedule_reason" text;--> statement-breakpoint
CREATE INDEX "jobs_due_idx" ON "jobs" USING btree ("stream","status","available_at");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_recovery_state_vocabulary" CHECK (recovery_state in ('verifying', 'monitoring', 'verified', 'not_verified'));