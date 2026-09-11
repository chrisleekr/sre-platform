ALTER TABLE "jobs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "event_key" text;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", "payload"->>'intakeId' AS "key",
		row_number() OVER (
			PARTITION BY "tenant_id", "payload"->>'intakeId'
			ORDER BY "created_at", "id"
		) AS "ordinal"
	FROM "jobs"
	WHERE "type" = 'classify' AND nullif("payload"->>'intakeId', '') IS NOT NULL
)
UPDATE "jobs"
SET "idempotency_key" = ranked."key"
FROM ranked
WHERE "jobs"."id" = ranked."id" AND ranked."ordinal" = 1;--> statement-breakpoint
WITH ranked AS (
	SELECT "id", "payload"->>'eventKey' AS "key",
		row_number() OVER (
			PARTITION BY "tenant_id", "payload"->>'eventKey'
			ORDER BY "created_at", "id"
		) AS "ordinal"
	FROM "jobs"
	WHERE "type" = 'classify' AND nullif("payload"->>'eventKey', '') IS NOT NULL
)
UPDATE "jobs"
SET "event_key" = ranked."key"
FROM ranked
WHERE "jobs"."id" = ranked."id" AND ranked."ordinal" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_classify_idempotency_uq" ON "jobs" USING btree ("tenant_id","idempotency_key") WHERE type = 'classify' AND idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_classify_event_uq" ON "jobs" USING btree ("tenant_id","event_key") WHERE type = 'classify' AND event_key IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION "jobs_project_classify_identity"() RETURNS trigger AS $$
BEGIN
	IF NEW."type" = 'classify' THEN
		NEW."idempotency_key" := nullif(NEW."payload"->>'intakeId', '');
		NEW."event_key" := nullif(NEW."payload"->>'eventKey', '');
	ELSE
		NEW."idempotency_key" := NULL;
		NEW."event_key" := NULL;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "jobs_project_classify_identity_insert"
BEFORE INSERT ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "jobs_project_classify_identity"();--> statement-breakpoint
CREATE TRIGGER "jobs_project_classify_identity_update"
BEFORE UPDATE OF "type", "payload" ON "jobs"
FOR EACH ROW EXECUTE FUNCTION "jobs_project_classify_identity"();
