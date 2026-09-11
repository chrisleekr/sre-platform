ALTER TABLE "workspace_foundings" DROP CONSTRAINT "workspace_foundings_status_check";--> statement-breakpoint
ALTER TABLE "workspace_foundings" ADD COLUMN "auth_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_foundings" ADD COLUMN "auth_attempt_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_foundings" ADD CONSTRAINT "workspace_foundings_status_check" CHECK (status in ('awaiting_founder','authenticating_founder','founder_authenticated','pending','approved','provisioning','active','failed','rejected','expired'));