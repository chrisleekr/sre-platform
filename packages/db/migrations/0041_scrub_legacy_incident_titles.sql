CREATE OR REPLACE FUNCTION "sre_scrub_legacy_incident_text"(input text) RETURNS text AS $$
DECLARE
	scrubbed text COLLATE "C" := input;
	token text COLLATE "C";
BEGIN
	scrubbed := regexp_replace(scrubbed, '(AKIA|ASIA)[0-9A-Z]{16}', '[REDACTED]', 'g');
	scrubbed := regexp_replace(
		scrubbed,
		'Bearer[\t-\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+[A-Za-z0-9._~+/-]+=*',
		'[REDACTED]',
		'gi'
	);
	scrubbed := regexp_replace(scrubbed, '(?<![A-Za-z0-9_])sk-[A-Za-z0-9]{20,}', '[REDACTED]', 'g');
	scrubbed := regexp_replace(scrubbed, '(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,}', '[REDACTED]', 'g');
	scrubbed := regexp_replace(scrubbed, '(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}', '[REDACTED]', 'g');
	scrubbed := regexp_replace(scrubbed, '(?<![A-Za-z0-9_])xox[baprs]-[A-Za-z0-9-]{10,}', '[REDACTED]', 'g');
	scrubbed := regexp_replace(
		scrubbed,
		'(?<![A-Za-z0-9_])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+',
		'[REDACTED]',
		'g'
	);
	FOR token IN
		SELECT token_match[1]
		FROM regexp_matches(
			scrubbed,
			'((?<![A-Za-z0-9_])[A-Za-z0-9]{32,}(?![A-Za-z0-9_]))',
			'g'
		) AS token_match
	LOOP
		IF token ~ '[a-z]' AND token ~ '[A-Z]' AND token ~ '[0-9]' THEN
			scrubbed := regexp_replace(
				scrubbed,
				'(?<![A-Za-z0-9_])' || token || '(?![A-Za-z0-9_])',
				'[REDACTED]',
				'g'
			);
		END IF;
	END LOOP;
	RETURN scrubbed;
END;
$$ LANGUAGE plpgsql IMMUTABLE STRICT;
--> statement-breakpoint
UPDATE "incident_signals"
SET "alert_name" = btrim("sre_scrub_legacy_incident_text"("alert_name"))
WHERE "alert_name" IS NOT NULL
	AND "alert_name" IS DISTINCT FROM btrim("sre_scrub_legacy_incident_text"("alert_name"));
--> statement-breakpoint
UPDATE "incidents"
SET "title" = btrim("sre_scrub_legacy_incident_text"("title"))
WHERE "title" IS NOT NULL
	AND "title" IS DISTINCT FROM btrim("sre_scrub_legacy_incident_text"("title"));
--> statement-breakpoint
UPDATE "incidents" AS incident
SET "title" = (
	SELECT left(btrim(signal."alert_name"), 120)
	FROM "incident_signals" AS signal
	WHERE signal."tenant_id" = incident."tenant_id"
		AND signal."incident_id" = incident."id"
		AND nullif(btrim(signal."alert_name"), '') IS NOT NULL
	ORDER BY signal."first_seen_at", signal."id"
	LIMIT 1
)
WHERE nullif(btrim(incident."title"), '') IS NULL
	AND EXISTS (
		SELECT 1
		FROM "incident_signals" AS signal
		WHERE signal."tenant_id" = incident."tenant_id"
			AND signal."incident_id" = incident."id"
			AND nullif(btrim(signal."alert_name"), '') IS NOT NULL
	);
--> statement-breakpoint
DROP FUNCTION "sre_scrub_legacy_incident_text"(text);
