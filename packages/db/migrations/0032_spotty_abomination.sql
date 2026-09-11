ALTER TABLE "incident_relations" ADD COLUMN "correlation_feedback" jsonb;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_method" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_rationale" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_features" jsonb;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_confidence" integer;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_window_started_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_window_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD COLUMN "correlation_max_age_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "correlation_max_age_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "incident_relations_correlation_feedback_idx" ON "incident_relations" USING gin ("correlation_feedback") WHERE "incident_relations"."correlation_feedback" is not null and "incident_relations"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "incident_signals_correlation_scope_idx" ON "incident_signals" USING btree ("tenant_id","data_source_id","monitor_key","state","incident_id","first_seen_at" DESC NULLS LAST) WHERE "incident_signals"."data_source_id" is not null and "incident_signals"."monitor_key" is not null;--> statement-breakpoint
CREATE INDEX "incident_signals_correlation_history_idx" ON "incident_signals" USING btree ("tenant_id","data_source_id","monitor_key","incident_id","first_seen_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "incident_signals"."data_source_id" is not null and "incident_signals"."monitor_key" is not null;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_correlation_feedback_shape" CHECK ("incident_relations"."correlation_feedback" is null or coalesce((
        "incident_relations"."decided_by" = 'human'
        and "incident_relations"."decided_by_user_id" is not null
        and jsonb_typeof("incident_relations"."correlation_feedback") = 'object'
        and "incident_relations"."correlation_feedback"->>'decision' in ('group', 'separate')
        and jsonb_typeof("incident_relations"."correlation_feedback"->'sourceScopeKeys') = 'array'
        and jsonb_typeof("incident_relations"."correlation_feedback"->'targetScopeKeys') = 'array'
        and jsonb_typeof("incident_relations"."correlation_feedback"->'sharedScopeKeys') = 'array'
        and not jsonb_path_exists("incident_relations"."correlation_feedback", '$.sourceScopeKeys[*] ? (@.type() != "string")')
        and not jsonb_path_exists("incident_relations"."correlation_feedback", '$.targetScopeKeys[*] ? (@.type() != "string")')
        and not jsonb_path_exists("incident_relations"."correlation_feedback", '$.sharedScopeKeys[*] ? (@.type() != "string")')
      ), false));--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_correlation_method_vocabulary" CHECK ("incident_signals"."correlation_method" is null or "incident_signals"."correlation_method" in ('new_incident', 'stable_subject_window'));--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_correlation_confidence_range" CHECK ("incident_signals"."correlation_confidence" is null or ("incident_signals"."correlation_confidence" >= 0 and "incident_signals"."correlation_confidence" <= 100));--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_correlation_decision_shape" CHECK ((
        (
          "incident_signals"."correlation_method" is null
          and "incident_signals"."correlation_rationale" is null
          and "incident_signals"."correlation_features" is null
          and "incident_signals"."correlation_confidence" is null
          and "incident_signals"."correlation_window_started_at" is null
          and "incident_signals"."correlation_window_expires_at" is null
          and "incident_signals"."correlation_max_age_at" is null
        )
        or coalesce((
          "incident_signals"."correlation_method" is not null
          and "incident_signals"."correlation_rationale" is not null
          and btrim("incident_signals"."correlation_rationale") <> ''
          and "incident_signals"."correlation_features" is not null
          and jsonb_typeof("incident_signals"."correlation_features") = 'array'
          and not jsonb_path_exists("incident_signals"."correlation_features", '$[*] ? (@.type() != "string")')
          and "incident_signals"."correlation_confidence" is not null
          and "incident_signals"."correlation_window_started_at" is not null
          and "incident_signals"."correlation_window_expires_at" is not null
          and "incident_signals"."correlation_max_age_at" is not null
          and "incident_signals"."correlation_window_expires_at" >= "incident_signals"."correlation_window_started_at"
          and "incident_signals"."correlation_max_age_at" >= "incident_signals"."correlation_window_started_at"
        ), false)
      ));
