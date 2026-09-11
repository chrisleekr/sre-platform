CREATE OR REPLACE FUNCTION "jobs_project_classify_identity"() RETURNS trigger AS $$
BEGIN
	IF NEW."type" = 'classify' THEN
		NEW."idempotency_key" := nullif(NEW."payload"->>'intakeId', '');
		NEW."event_key" := nullif(NEW."payload"->>'eventKey', '');
	ELSIF NEW."type" = 'founding.provision' THEN
		NEW."idempotency_key" := nullif(NEW."payload"->>'foundingId', '');
		NEW."event_key" := NULL;
	ELSE
		NEW."idempotency_key" := NULL;
		NEW."event_key" := NULL;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_founding_live_uq" ON "jobs" USING btree ("tenant_id","idempotency_key") WHERE type = 'founding.provision' AND status IN ('queued', 'processing') AND idempotency_key IS NOT NULL;
