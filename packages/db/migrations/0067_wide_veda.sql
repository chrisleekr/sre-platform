ALTER TABLE "slos" ADD COLUMN "last_eval_error" text;--> statement-breakpoint
ALTER TABLE "slos" ADD COLUMN "eval_failing_since" timestamp (3) with time zone;