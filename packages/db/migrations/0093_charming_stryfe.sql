ALTER TABLE "gitlab_projects" ADD COLUMN "container_registry_image_prefix" text;--> statement-breakpoint
-- Argo CD Helm sources were recorded as GitLab repositories named after the chart registry API path.
-- A package feed holds no source, and the poller no longer writes these rows.
DELETE FROM "service_repositories"
WHERE "provider" = 'gitlab' AND "source" = 'argocd' AND "repository_full_name" LIKE 'api/v4/projects/%';
