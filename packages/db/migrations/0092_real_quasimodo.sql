-- Workers from the previous release keep enqueueing during the upgrade; hold writers off until the
-- index exists so none can slip a second queued pass in between the retire and the build. The drizzle
-- migrator runs every pending file in one transaction, so the lock holds until that commit. DO keeps
-- the file runnable by appliers that execute one statement at a time (the migration replay tests),
-- where bare LOCK is rejected and the lock protects nothing. The timeout fails the upgrade rather
-- than stalling every job writer behind a long-running transaction; it is reset so later statements
-- in the same migration transaction keep the default.
DO $$ BEGIN
	SET LOCAL lock_timeout = '10s';
	LOCK TABLE "jobs" IN SHARE ROW EXCLUSIVE MODE;
	SET LOCAL lock_timeout = DEFAULT;
END $$;--> statement-breakpoint
-- Every pass reads live provider state, so one queued pass per connector does all the work the backlog
-- represents. A full pass (no collections) is kept over a page continuation, which reads only some
-- collections; the oldest wins a tie. Retiring the rest is lossless; their stream entries are refused
-- and acked. The index skips a NULL connectorId, so such rows are never deduplicated and are left alone.
WITH ranked AS (
	SELECT "id",
		row_number() OVER (
			PARTITION BY "tenant_id", "payload"->>'connectorId'
			ORDER BY ("payload" ? 'collections'), "created_at", "id"
		) AS "ordinal"
	FROM "jobs"
	WHERE "type" = 'topology.discover'
		AND "status" = 'queued'
		AND "payload"->>'connectorId' IS NOT NULL
)
UPDATE "jobs"
SET "status" = 'done', "updated_at" = now()
FROM ranked
WHERE "jobs"."id" = ranked."id" AND ranked."ordinal" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_topology_discover_coalesce_idx" ON "jobs" USING btree ("tenant_id",(payload->>'connectorId')) WHERE type = 'topology.discover' AND status = 'queued';
