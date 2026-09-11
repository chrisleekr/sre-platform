ALTER TABLE "incident_signals" ADD COLUMN "last_event_version" bigint;--> statement-breakpoint
CREATE FUNCTION "incident_signals_project_event_version"() RETURNS trigger AS $$
DECLARE
	old_floor bigint;
	next_version bigint;
BEGIN
	IF NEW."last_event_version" IS NOT DISTINCT FROM OLD."last_event_version" THEN
		IF NEW."last_event_at" <= OLD."last_event_at" THEN
			RETURN OLD;
		END IF;
		old_floor := GREATEST(
			COALESCE(OLD."last_event_version", (extract(epoch from OLD."last_event_at") * 1000000)::bigint + 999),
			(extract(epoch from OLD."last_event_at") * 1000000)::bigint
		);
		next_version := (extract(epoch from NEW."last_event_at") * 1000000)::bigint + 999;
		IF next_version <= old_floor THEN
			RETURN OLD;
		END IF;
		NEW."last_event_version" := next_version;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "incident_signals_project_event_version_update"
BEFORE UPDATE OF "last_event_at" ON "incident_signals"
FOR EACH ROW EXECUTE FUNCTION "incident_signals_project_event_version"();--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD COLUMN "terminal_disposition_event_version" bigint;
--> statement-breakpoint
CREATE FUNCTION "incident_signals_guard_terminal_surface_decision"() RETURNS trigger AS $$
DECLARE
	stable_message_id text;
	incoming_version bigint;
	decision_disposition text;
	decision_version bigint;
	session_tenant uuid;
	session_can_bypass_rls boolean;
BEGIN
	IF NEW."state" = 'resolved' THEN
		RETURN NEW;
	END IF;

	session_tenant := nullif(current_setting('app.tenant_id', true), '')::uuid;
	IF session_tenant IS NULL THEN
		SELECT role.rolsuper OR role.rolbypassrls OR role.oid = relation.relowner
		INTO session_can_bypass_rls
		FROM pg_catalog.pg_roles AS role
		CROSS JOIN pg_catalog.pg_class AS relation
		WHERE role.rolname = SESSION_USER
			AND relation.oid = 'public.incident_signals'::regclass;
		IF NOT coalesce(session_can_bypass_rls, false) THEN
			RAISE EXCEPTION USING
				ERRCODE = '42501',
				MESSAGE = 'incident signal write requires tenant scope';
		END IF;
	ELSIF NEW."tenant_id" <> session_tenant THEN
		RAISE EXCEPTION USING
			ERRCODE = '42501',
			MESSAGE = 'incident signal tenant does not match session scope';
	END IF;

	SELECT event."external_message_id"
	INTO stable_message_id
	FROM public."surface_inbound_events" AS event
	WHERE event."tenant_id" = NEW."tenant_id"
		AND event."surface" = NEW."surface"
		AND event."channel" = NEW."channel"
		AND event."external_message_id" IS NOT NULL
		AND (
			NEW."external_message_id" = event."external_message_id"
			OR left(NEW."external_message_id", length(event."external_message_id") + 1)
				= event."external_message_id" || '#'
		)
	ORDER BY length(event."external_message_id") DESC, event."accepted_at" DESC
	LIMIT 1;

	IF stable_message_id IS NULL THEN
		RETURN NEW;
	END IF;

	PERFORM pg_catalog.pg_advisory_xact_lock(
		pg_catalog.hashtextextended(
			'surface-inbound:' || NEW."tenant_id"::text || ':' || NEW."surface" || ':' ||
			NEW."channel" || ':' || stable_message_id,
			0
		)
	);

	SELECT event."terminal_disposition",
		coalesce(
			event."terminal_disposition_event_version",
			(extract(epoch from event."terminal_disposition_event_at") * 1000000)::bigint + 999
		)
	INTO decision_disposition, decision_version
	FROM public."surface_inbound_events" AS event
	WHERE event."tenant_id" = NEW."tenant_id"
		AND event."surface" = NEW."surface"
		AND event."channel" = NEW."channel"
		AND event."external_message_id" = stable_message_id
	ORDER BY
		coalesce(
			event."terminal_disposition_event_version",
			(extract(epoch from event."terminal_disposition_event_at") * 1000000)::bigint + 999
		) DESC NULLS LAST,
		(event."terminal_disposition" IS NOT NULL) DESC,
		event."terminal_disposition_at" DESC NULLS LAST
	LIMIT 1;

	incoming_version := coalesce(
		NEW."last_event_version",
		(extract(epoch from NEW."last_event_at") * 1000000)::bigint + 999
	);
	IF decision_disposition IS NOT NULL AND decision_version >= incoming_version THEN
		RAISE EXCEPTION USING
			ERRCODE = 'P2871',
			MESSAGE = 'incident signal superseded by terminal surface decision';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public;
--> statement-breakpoint
CREATE TRIGGER "incident_signals_guard_terminal_surface_decision_insert"
BEFORE INSERT ON "incident_signals"
FOR EACH ROW EXECUTE FUNCTION "incident_signals_guard_terminal_surface_decision"();
--> statement-breakpoint
CREATE TRIGGER "incident_signals_guard_terminal_surface_decision_update"
BEFORE UPDATE OF "state", "last_event_at", "last_event_version", "surface", "channel", "external_message_id"
ON "incident_signals"
FOR EACH ROW EXECUTE FUNCTION "incident_signals_guard_terminal_surface_decision"();
