CREATE TABLE "incident_tag_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"applied_at" timestamp (3) with time zone,
	"applied_tag_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_tag_suggestions_run_tag_uq" UNIQUE("tenant_id","incident_id","run_id","tag"),
	CONSTRAINT "incident_tag_suggestions_cause" CHECK (tag like 'cause:%'),
	CONSTRAINT "incident_tag_suggestions_evidence" CHECK (cardinality(evidence_ids) > 0)
);
--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incident_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_tags_value_uq" UNIQUE("tenant_id","incident_id","tag"),
	CONSTRAINT "incident_tags_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_tags_not_blank" CHECK (btrim(tag) <> ''),
	CONSTRAINT "incident_tags_length" CHECK (char_length(tag) <= 128),
	CONSTRAINT "incident_tags_no_whitespace" CHECK (tag !~ '[[:space:]]'),
	CONSTRAINT "incident_tags_source" CHECK (source in ('dashboard', 'slack'))
);
--> statement-breakpoint
ALTER TABLE "incident_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "signal_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_event_key" text NOT NULL,
	"signal_key" text NOT NULL,
	"data_source_id" uuid,
	"surface" text NOT NULL,
	"channel" text NOT NULL,
	"thread_id" text NOT NULL,
	"summary" text NOT NULL,
	"reason" text NOT NULL,
	"service" text,
	"severity" text,
	"disposition" text NOT NULL,
	"classification_mode" text DEFAULT 'shadow' NOT NULL,
	"effective_disposition" text,
	"correlation_decision" text,
	"correlated_incident_id" uuid,
	"incident_id" uuid,
	"action" text,
	"safe_deferral_reason" text,
	"risk_if_ignored" text,
	"review_horizon_minutes" integer,
	"resolved_at" timestamp (3) with time zone,
	"superseded_at" timestamp (3) with time zone,
	"review_started_at" timestamp (3) with time zone,
	"promotion_suggested_at" timestamp (3) with time zone,
	"promoted_at" timestamp (3) with time zone,
	"promoted_by_user_id" uuid,
	"promoted_by_surface" text,
	"promoted_by_actor" text,
	"promotion_criterion" text,
	"promotion_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_dispositions_source_event_uq" UNIQUE("tenant_id","source","source_event_key"),
	CONSTRAINT "signal_dispositions_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "signal_dispositions_vocabulary" CHECK (disposition in ('investigate', 'ticket', 'log')),
	CONSTRAINT "signal_dispositions_mode" CHECK (classification_mode in ('shadow', 'enforce')),
	CONSTRAINT "signal_dispositions_effective_vocabulary" CHECK (effective_disposition is null or effective_disposition in ('investigate', 'ticket', 'log')),
	CONSTRAINT "signal_dispositions_ticket_shape" CHECK ((
        disposition <> 'ticket'
        or (
          action is not null
          and safe_deferral_reason is not null
          and risk_if_ignored is not null
          and review_horizon_minutes between 1 and 10080
        )
      )),
	CONSTRAINT "signal_dispositions_promotion_shape" CHECK ((
        promoted_at is null
        or (
          disposition = 'ticket'
          and incident_id is not null
          and promoted_by_surface is not null
          and promoted_by_actor is not null
          and promotion_criterion is not null
          and promotion_reason is not null
        )
      ))
);
--> statement-breakpoint
ALTER TABLE "signal_dispositions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_signal_policies" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"second_team_enabled" boolean DEFAULT true NOT NULL,
	"customer_visible_enabled" boolean DEFAULT true NOT NULL,
	"unsolved_after_minutes" integer DEFAULT 60,
	"classification_mode" text DEFAULT 'shadow' NOT NULL,
	"enforcement_approved_at" timestamp (3) with time zone,
	"enforcement_approved_by_user_id" uuid,
	"corpus_critical_safety_misses" integer,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_signal_policies_retention" CHECK (retention_days between 1 and 3650),
	CONSTRAINT "tenant_signal_policies_unsolved" CHECK (unsolved_after_minutes is null or unsolved_after_minutes between 1 and 10080),
	CONSTRAINT "tenant_signal_policies_mode" CHECK (classification_mode in ('shadow', 'enforce')),
	CONSTRAINT "tenant_signal_policies_corpus_misses" CHECK (corpus_critical_safety_misses is null or corpus_critical_safety_misses >= 0),
	CONSTRAINT "tenant_signal_policies_enforcement" CHECK (classification_mode <> 'enforce' or (
        enforcement_approved_at is not null
        and enforcement_approved_by_user_id is not null
        and corpus_critical_safety_misses = 0
      ))
);
--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenant_tag_link_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"url_template" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_tag_link_rules_prefix_uq" UNIQUE("tenant_id","prefix"),
	CONSTRAINT "tenant_tag_link_rules_prefix" CHECK (prefix <> '' and prefix !~ '[[:space:]:]')
);
--> statement-breakpoint
ALTER TABLE "tenant_tag_link_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_run_fk" FOREIGN KEY ("tenant_id","incident_id","run_id") REFERENCES "public"."investigation_runs"("tenant_id","incident_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_applied_tag_fk" FOREIGN KEY ("tenant_id","applied_tag_id") REFERENCES "public"."incident_tags"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tags" ADD CONSTRAINT "incident_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tags" ADD CONSTRAINT "incident_tags_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tags" ADD CONSTRAINT "incident_tags_actor_membership_fk" FOREIGN KEY ("actor_user_id","tenant_id") REFERENCES "public"."memberships"("user_id","tenant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_promoted_by_user_id_users_id_fk" FOREIGN KEY ("promoted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_data_source_fk" FOREIGN KEY ("tenant_id","data_source_id") REFERENCES "public"."connector_configs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_correlated_incident_fk" FOREIGN KEY ("tenant_id","correlated_incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_approved_by_fk" FOREIGN KEY ("enforcement_approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_tag_link_rules" ADD CONSTRAINT "tenant_tag_link_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_dispositions_current_signal_uq" ON "signal_dispositions" USING btree ("tenant_id","source","signal_key") WHERE "signal_dispositions"."superseded_at" is null;--> statement-breakpoint
CREATE INDEX "signal_dispositions_inbox_idx" ON "signal_dispositions" USING btree ("tenant_id","disposition","resolved_at","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_tag_suggestions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "incident_tags" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "signal_dispositions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_signal_policies" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenant_tag_link_rules" AS PERMISSIVE FOR ALL TO public USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);