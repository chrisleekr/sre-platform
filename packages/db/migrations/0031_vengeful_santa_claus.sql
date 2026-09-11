ALTER TABLE "incident_signals" ADD COLUMN "monitor_key" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "last_investigated_version" integer;--> statement-breakpoint
UPDATE "incident_signals" SET "last_investigated_version" = "version" WHERE "last_investigated_material_hash" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_last_investigated_version_positive" CHECK ("incident_signals"."last_investigated_version" is null or "incident_signals"."last_investigated_version" > 0);--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_nonnegative_usage" CHECK ("llm_invocations"."request_count" >= 0 and "llm_invocations"."input_tokens" >= 0 and "llm_invocations"."output_tokens" >= 0 and "llm_invocations"."cache_read_tokens" >= 0 and "llm_invocations"."cache_write_tokens" >= 0);--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_configured_cost_nonnegative_finite" CHECK ("llm_invocations"."configured_cost_usd" is null or ("llm_invocations"."request_count" > 0 and "llm_invocations"."input_tokens" + "llm_invocations"."output_tokens" + "llm_invocations"."cache_read_tokens" + "llm_invocations"."cache_write_tokens" > 0 and "llm_invocations"."configured_cost_usd" >= 0 and "llm_invocations"."configured_cost_usd" < 'Infinity'::numeric));--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_provider_cost_nonnegative_finite" CHECK ("llm_invocations"."provider_estimated_cost_usd" is null or ("llm_invocations"."provider_estimated_cost_usd" >= 0 and "llm_invocations"."provider_estimated_cost_usd" < 'Infinity'::numeric));--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "job_id" uuid;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "trigger_reason" text;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "trigger_automatic" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "trigger_monitor_key" text;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "trigger_monitor_keys" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "trigger_budget" jsonb;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD COLUMN "admission_denied" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_investigation_run_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF current_user = 'app_user' THEN
			RAISE EXCEPTION 'investigation runs cannot be deleted by the application role' USING ERRCODE = '55000';
		END IF;
		RETURN OLD;
	END IF;
	IF current_user = 'app_user' AND OLD.completed_at IS NOT NULL THEN
		RAISE EXCEPTION 'completed investigation runs are immutable' USING ERRCODE = '55000';
	END IF;
	IF current_user = 'app_user' AND (NEW.id IS DISTINCT FROM OLD.id
		OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
		OR NEW.incident_id IS DISTINCT FROM OLD.incident_id
		OR NEW.job_id IS DISTINCT FROM OLD.job_id
		OR NEW.operation IS DISTINCT FROM OLD.operation
		OR NEW.trigger_reason IS DISTINCT FROM OLD.trigger_reason
		OR NEW.trigger_automatic IS DISTINCT FROM OLD.trigger_automatic
		OR NEW.trigger_monitor_key IS DISTINCT FROM OLD.trigger_monitor_key
		OR NEW.trigger_monitor_keys IS DISTINCT FROM OLD.trigger_monitor_keys
		OR NEW.trigger_budget IS DISTINCT FROM OLD.trigger_budget
		OR NEW.admission_denied IS DISTINCT FROM OLD.admission_denied
		OR NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
		RAISE EXCEPTION 'investigation run identity and admission provenance are immutable' USING ERRCODE = '55000';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE INDEX "investigation_runs_automatic_started_idx" ON "investigation_runs" USING btree ("tenant_id","trigger_automatic","started_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_trigger_reason_vocabulary" CHECK ("investigation_runs"."trigger_reason" is null or trigger_reason in ('new_episode', 'state_transition', 'material_change', 'unchanged_renotification', 'human_continuation', 'recovery_verification', 'manual_investigation'));
