ALTER TABLE "connector_configs" DROP CONSTRAINT "connector_configs_tenant_id_type_unique";--> statement-breakpoint
ALTER TABLE "github_events" DROP CONSTRAINT "github_events_delivery_uq";--> statement-breakpoint
ALTER TABLE "github_repositories" DROP CONSTRAINT "github_repositories_provider_uq";--> statement-breakpoint
ALTER TABLE "gitlab_events" DROP CONSTRAINT "gitlab_events_delivery_uq";--> statement-breakpoint
ALTER TABLE "gitlab_projects" DROP CONSTRAINT "gitlab_projects_provider_uq";--> statement-breakpoint
DROP INDEX "deployments_provider_event_uq";--> statement-breakpoint
DROP INDEX "deployments_argocd_provider_event_uq";--> statement-breakpoint
DROP INDEX "deployments_legacy_sha_uq";--> statement-breakpoint
DROP INDEX "github_events_timeline_idx";--> statement-breakpoint
DROP INDEX "github_repositories_active_name_uq";--> statement-breakpoint
DROP INDEX "github_repositories_installation_idx";--> statement-breakpoint
DROP INDEX "gitlab_events_timeline_idx";--> statement-breakpoint
DROP INDEX "gitlab_projects_active_path_uq";--> statement-breakpoint
DROP INDEX "gitlab_projects_group_idx";--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "name" text DEFAULT 'Data source' NOT NULL;--> statement-breakpoint
ALTER TABLE "connector_configs" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "github_events" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "github_manifest_sessions" ADD COLUMN "data_source_name" text DEFAULT 'GitHub' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_repositories" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "gitlab_events" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
ALTER TABLE "gitlab_projects" ADD COLUMN "connector_id" uuid;--> statement-breakpoint
UPDATE "connector_configs"
SET "name" = CASE "type"
  WHEN 'argocd' THEN 'Argo CD'
  WHEN 'aws' THEN 'AWS'
  WHEN 'datadog' THEN 'Datadog'
  WHEN 'github' THEN 'GitHub'
  WHEN 'gitlab' THEN 'GitLab'
  WHEN 'grafana' THEN 'Grafana'
  WHEN 'kubernetes' THEN 'Kubernetes'
  WHEN 'networkprobe' THEN 'Network probe'
  WHEN 'prometheus' THEN 'Prometheus'
  WHEN 'statuscake' THEN 'StatusCake'
  ELSE initcap("type")
END;--> statement-breakpoint
UPDATE "tenant_secrets" AS "secret"
SET "name" = 'connector:' || "connector"."id"::text,
    "updated_at" = now()
FROM "connector_configs" AS "connector"
WHERE "secret"."tenant_id" = "connector"."tenant_id"
  AND "secret"."name" = 'connector:' || "connector"."type";--> statement-breakpoint
UPDATE "github_events" AS "event"
SET "connector_id" = "connector"."id"
FROM "connector_configs" AS "connector"
WHERE "event"."tenant_id" = "connector"."tenant_id"
  AND "connector"."type" = 'github';--> statement-breakpoint
UPDATE "github_repositories" AS "repository"
SET "connector_id" = "connector"."id"
FROM "connector_configs" AS "connector"
WHERE "repository"."tenant_id" = "connector"."tenant_id"
  AND "connector"."type" = 'github';--> statement-breakpoint
UPDATE "gitlab_events" AS "event"
SET "connector_id" = "connector"."id"
FROM "connector_configs" AS "connector"
WHERE "event"."tenant_id" = "connector"."tenant_id"
  AND "connector"."type" = 'gitlab';--> statement-breakpoint
UPDATE "gitlab_projects" AS "project"
SET "connector_id" = "connector"."id"
FROM "connector_configs" AS "connector"
WHERE "project"."tenant_id" = "connector"."tenant_id"
  AND "connector"."type" = 'gitlab';--> statement-breakpoint
UPDATE "deployments" AS "deployment"
SET "connector_id" = "connector"."id"
FROM "connector_configs" AS "connector"
WHERE "deployment"."tenant_id" = "connector"."tenant_id"
  AND "deployment"."source" = "connector"."type";--> statement-breakpoint
CREATE UNIQUE INDEX "connector_configs_active_name_uq" ON "connector_configs" USING btree ("tenant_id","type",lower("name")) WHERE "connector_configs"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "connector_configs_tenant_type_idx" ON "connector_configs" USING btree ("tenant_id","type","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_unscoped_provider_event_uq" ON "deployments" USING btree ("tenant_id","source","repo","provider_id") WHERE "deployments"."connector_id" is null and "deployments"."provider_id" is not null and "deployments"."source" <> 'argocd';--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_unscoped_argocd_provider_event_uq" ON "deployments" USING btree ("tenant_id","source","provider_id") WHERE "deployments"."connector_id" is null and "deployments"."provider_id" is not null and "deployments"."source" = 'argocd';--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_unscoped_legacy_sha_uq" ON "deployments" USING btree ("tenant_id","source","sha") WHERE "deployments"."connector_id" is null and "deployments"."provider_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_events_delivery_uq" ON "github_events" USING btree ("tenant_id","connector_id","delivery_id") WHERE "github_events"."connector_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_events_legacy_delivery_uq" ON "github_events" USING btree ("tenant_id","delivery_id") WHERE "github_events"."connector_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_provider_uq" ON "github_repositories" USING btree ("tenant_id","connector_id","repository_id") WHERE "github_repositories"."connector_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_legacy_provider_uq" ON "github_repositories" USING btree ("tenant_id","repository_id") WHERE "github_repositories"."connector_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_events_delivery_uq" ON "gitlab_events" USING btree ("tenant_id","connector_id","delivery_id") WHERE "gitlab_events"."connector_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_events_legacy_delivery_uq" ON "gitlab_events" USING btree ("tenant_id","delivery_id") WHERE "gitlab_events"."connector_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_projects_provider_uq" ON "gitlab_projects" USING btree ("tenant_id","connector_id","project_id") WHERE "gitlab_projects"."connector_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_projects_legacy_provider_uq" ON "gitlab_projects" USING btree ("tenant_id","project_id") WHERE "gitlab_projects"."connector_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_provider_event_uq" ON "deployments" USING btree ("tenant_id","connector_id","source","repo","provider_id") WHERE "deployments"."connector_id" is not null and "deployments"."provider_id" is not null and "deployments"."source" <> 'argocd';--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_argocd_provider_event_uq" ON "deployments" USING btree ("tenant_id","connector_id","source","provider_id") WHERE "deployments"."connector_id" is not null and "deployments"."provider_id" is not null and "deployments"."source" = 'argocd';--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_legacy_sha_uq" ON "deployments" USING btree ("tenant_id","connector_id","source","sha") WHERE "deployments"."connector_id" is not null and "deployments"."provider_id" is null;--> statement-breakpoint
CREATE INDEX "github_events_timeline_idx" ON "github_events" USING btree ("tenant_id","connector_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "github_repositories_active_name_uq" ON "github_repositories" USING btree ("tenant_id","connector_id","full_name") WHERE "github_repositories"."connector_id" is not null and "github_repositories"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "github_repositories_installation_idx" ON "github_repositories" USING btree ("tenant_id","connector_id","installation_id","removed_at");--> statement-breakpoint
CREATE INDEX "gitlab_events_timeline_idx" ON "gitlab_events" USING btree ("tenant_id","connector_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_projects_active_path_uq" ON "gitlab_projects" USING btree ("tenant_id","connector_id","full_path") WHERE "gitlab_projects"."connector_id" is not null and "gitlab_projects"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "gitlab_projects_group_idx" ON "gitlab_projects" USING btree ("tenant_id","connector_id","group_id","removed_at");
