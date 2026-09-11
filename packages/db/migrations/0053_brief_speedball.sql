ALTER TABLE "tenant_signal_policies" ADD COLUMN "measurement_started_at" timestamp (3) with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
INSERT INTO "tenant_signal_policies" ("tenant_id", "measurement_started_at")
SELECT "tenant_id", min("created_at")
FROM "signal_dispositions"
GROUP BY "tenant_id"
ON CONFLICT ("tenant_id") DO UPDATE
SET "measurement_started_at" = least(
  "tenant_signal_policies"."measurement_started_at",
  excluded."measurement_started_at"
);
