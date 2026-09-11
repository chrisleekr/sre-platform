ALTER TABLE "incidents" ADD COLUMN "recovery_state" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_summary" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "recovery_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_recovery_state_vocabulary" CHECK (recovery_state in ('verifying', 'verified', 'not_verified'));--> statement-breakpoint
WITH "latest_recovery" AS (
	SELECT DISTINCT ON ("tenant_id", "incident_id")
		"tenant_id",
		"incident_id",
		"summary",
		"content",
		"created_at"
	FROM "incident_messages"
	WHERE "kind" = 'finding' AND "origin_message_id" LIKE 'recovery:%'
	ORDER BY "tenant_id", "incident_id", "created_at" DESC, "id" DESC
)
UPDATE "incidents"
SET
	"recovery_state" = CASE
		WHEN "latest_recovery"."content" LIKE 'Recovery verification proposal:%' THEN 'verified'
		ELSE 'not_verified'
	END,
	"recovery_summary" = "latest_recovery"."summary",
	"recovery_updated_at" = "latest_recovery"."created_at"
FROM "latest_recovery"
WHERE
	"incidents"."tenant_id" = "latest_recovery"."tenant_id"
	AND "incidents"."id" = "latest_recovery"."incident_id";
