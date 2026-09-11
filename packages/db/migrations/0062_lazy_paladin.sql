ALTER TABLE "agent_tool_calls" DROP CONSTRAINT "agent_tool_calls_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "alert_cohort_members" DROP CONSTRAINT "alert_cohort_members_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "alert_cohorts" DROP CONSTRAINT "alert_cohorts_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" DROP CONSTRAINT "alert_episode_intakes_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "connector_configs" DROP CONSTRAINT "connector_configs_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "impersonation_sessions" DROP CONSTRAINT "impersonation_sessions_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_identity_bindings" DROP CONSTRAINT "tenant_identity_bindings_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_invitations" DROP CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_foundings" DROP CONSTRAINT "workspace_foundings_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "deployments" DROP CONSTRAINT "deployments_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_service_mappings" DROP CONSTRAINT "entity_service_mappings_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "github_events" DROP CONSTRAINT "github_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "github_manifest_sessions" DROP CONSTRAINT "github_manifest_sessions_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "github_repositories" DROP CONSTRAINT "github_repositories_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "service_repositories" DROP CONSTRAINT "service_repositories_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_events" DROP CONSTRAINT "gitlab_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "gitlab_projects" DROP CONSTRAINT "gitlab_projects_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "inbound_side_effects" DROP CONSTRAINT "inbound_side_effects_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_attachments" DROP CONSTRAINT "incident_attachments_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_feedback" DROP CONSTRAINT "incident_feedback_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_messages" DROP CONSTRAINT "incident_messages_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_relations" DROP CONSTRAINT "incident_relations_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_signals" DROP CONSTRAINT "incident_signals_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incidents" DROP CONSTRAINT "incidents_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "investigation_subjects" DROP CONSTRAINT "investigation_subjects_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "investigation_runs" DROP CONSTRAINT "investigation_runs_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" DROP CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_invocations" DROP CONSTRAINT "llm_invocations_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "llm_telemetry_events" DROP CONSTRAINT "llm_telemetry_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_secrets" DROP CONSTRAINT "tenant_secrets_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" DROP CONSTRAINT "incident_tag_suggestions_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "incident_tags" DROP CONSTRAINT "incident_tags_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" DROP CONSTRAINT "signal_disposition_evaluations_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "signal_dispositions" DROP CONSTRAINT "signal_dispositions_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" DROP CONSTRAINT "tenant_signal_policies_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_tag_link_rules" DROP CONSTRAINT "tenant_tag_link_rules_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_deliveries" DROP CONSTRAINT "surface_deliveries_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_identities" DROP CONSTRAINT "surface_identities_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_inbound_events" DROP CONSTRAINT "surface_inbound_events_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_working_posts" DROP CONSTRAINT "surface_working_posts_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "inbound_channels" DROP CONSTRAINT "inbound_channels_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_bindings" DROP CONSTRAINT "surface_bindings_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "surface_configs" DROP CONSTRAINT "surface_configs_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "service_dependencies" DROP CONSTRAINT "service_dependencies_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "services" DROP CONSTRAINT "services_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "identity_providers" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "require_directory" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohort_members" ADD CONSTRAINT "alert_cohort_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_cohorts" ADD CONSTRAINT "alert_cohorts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_episode_intakes" ADD CONSTRAINT "alert_episode_intakes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD CONSTRAINT "connector_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "impersonation_sessions" ADD CONSTRAINT "impersonation_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_identity_bindings" ADD CONSTRAINT "tenant_identity_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_invitations" ADD CONSTRAINT "tenant_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_foundings" ADD CONSTRAINT "workspace_foundings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_service_mappings" ADD CONSTRAINT "entity_service_mappings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_events" ADD CONSTRAINT "github_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_manifest_sessions" ADD CONSTRAINT "github_manifest_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD CONSTRAINT "github_repositories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_repositories" ADD CONSTRAINT "service_repositories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_events" ADD CONSTRAINT "gitlab_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD CONSTRAINT "gitlab_projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_side_effects" ADD CONSTRAINT "inbound_side_effects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_attachments" ADD CONSTRAINT "incident_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_feedback" ADD CONSTRAINT "incident_feedback_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_messages" ADD CONSTRAINT "incident_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_relations" ADD CONSTRAINT "incident_relations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_subjects" ADD CONSTRAINT "investigation_subjects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_runs" ADD CONSTRAINT "investigation_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_telemetry_events" ADD CONSTRAINT "llm_telemetry_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_secrets" ADD CONSTRAINT "tenant_secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_tags" ADD CONSTRAINT "incident_tags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_disposition_evaluations" ADD CONSTRAINT "signal_disposition_evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_dispositions" ADD CONSTRAINT "signal_dispositions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_signal_policies" ADD CONSTRAINT "tenant_signal_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_tag_link_rules" ADD CONSTRAINT "tenant_tag_link_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_deliveries" ADD CONSTRAINT "surface_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_identities" ADD CONSTRAINT "surface_identities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_inbound_events" ADD CONSTRAINT "surface_inbound_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_working_posts" ADD CONSTRAINT "surface_working_posts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbound_channels" ADD CONSTRAINT "inbound_channels_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_configs" ADD CONSTRAINT "surface_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_dependencies" ADD CONSTRAINT "service_dependencies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_tenant_purge_live_uq" ON "jobs" USING btree ((payload->>'tenantId')) WHERE type = 'tenant.purge' AND status IN ('queued', 'processing');