ALTER TABLE "incident_feedback" ADD COLUMN IF NOT EXISTS "revision" integer;
--> statement-breakpoint
WITH missing AS (
	SELECT feedback."id",
		coalesce(existing."maximum", 0) + row_number() OVER (
			PARTITION BY feedback."tenant_id", feedback."target_type", feedback."target_id"
			ORDER BY feedback."created_at", feedback."id"
		)::integer AS "repaired_revision"
	FROM "incident_feedback" AS feedback
	LEFT JOIN LATERAL (
		SELECT max(existing_feedback."revision") AS "maximum"
		FROM "incident_feedback" AS existing_feedback
		WHERE existing_feedback."tenant_id" = feedback."tenant_id"
			AND existing_feedback."target_type" = feedback."target_type"
			AND existing_feedback."target_id" = feedback."target_id"
			AND existing_feedback."revision" IS NOT NULL
	) AS existing ON true
	WHERE feedback."revision" IS NULL
)
UPDATE "incident_feedback"
SET "revision" = missing."repaired_revision"
FROM missing
WHERE "incident_feedback"."id" = missing."id";
--> statement-breakpoint
ALTER TABLE "incident_feedback" ALTER COLUMN "revision" SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "incident_feedback" ALTER COLUMN "revision" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "incident_feedback_target_revision_uq"
	ON "incident_feedback" USING btree ("tenant_id", "target_type", "target_id", "revision");
