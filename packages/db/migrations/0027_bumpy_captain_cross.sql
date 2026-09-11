ALTER TABLE "surface_working_posts" DROP CONSTRAINT "surface_working_posts_uq";--> statement-breakpoint
ALTER TABLE "surface_working_posts" DROP CONSTRAINT "surface_working_posts_incident_fk";
--> statement-breakpoint
ALTER TABLE "surface_working_posts" ADD COLUMN "binding_id" uuid;--> statement-breakpoint
UPDATE "surface_working_posts" AS "working"
SET "binding_id" = "delivery"."binding_id"
FROM "surface_deliveries" AS "delivery"
WHERE "delivery"."tenant_id" = "working"."tenant_id"
  AND "delivery"."incident_id" = "working"."incident_id"
  AND "delivery"."surface" = "working"."surface"
  AND "delivery"."remote_message_id" = "working"."message_ts";--> statement-breakpoint
UPDATE "surface_working_posts" AS "working"
SET "binding_id" = "binding"."id"
FROM "surface_bindings" AS "binding"
WHERE "working"."binding_id" IS NULL
  AND "binding"."tenant_id" = "working"."tenant_id"
  AND "binding"."incident_id" = "working"."incident_id"
  AND "binding"."surface" = "working"."surface"
  AND "binding"."role" = 'primary';--> statement-breakpoint
DELETE FROM "surface_working_posts" WHERE "binding_id" IS NULL;--> statement-breakpoint
ALTER TABLE "surface_working_posts" ALTER COLUMN "binding_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_working_posts" ADD CONSTRAINT "surface_working_posts_binding_fk" FOREIGN KEY ("tenant_id","binding_id") REFERENCES "public"."surface_bindings"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_working_posts" DROP COLUMN "incident_id";--> statement-breakpoint
ALTER TABLE "surface_working_posts" DROP COLUMN "surface";--> statement-breakpoint
ALTER TABLE "surface_working_posts" ADD CONSTRAINT "surface_working_posts_uq" UNIQUE("tenant_id","binding_id");--> statement-breakpoint
CREATE TEMP TABLE "sre_0027_latest_correlated" AS
WITH "current_primary" AS (
  SELECT "id", "tenant_id", "incident_id", "surface", "channel"
  FROM "surface_bindings"
  WHERE "role" = 'primary'
)
  SELECT DISTINCT ON ("binding"."tenant_id", "binding"."incident_id", "binding"."surface")
    "binding"."tenant_id", "binding"."incident_id", "binding"."surface", "binding"."id"
  FROM "surface_bindings" AS "binding"
  LEFT JOIN "current_primary" AS "primary"
    ON "primary"."tenant_id" = "binding"."tenant_id"
   AND "primary"."incident_id" = "binding"."incident_id"
   AND "primary"."surface" = "binding"."surface"
  LEFT JOIN "surface_working_posts" AS "working"
    ON "working"."tenant_id" = "primary"."tenant_id"
   AND "working"."binding_id" = "primary"."id"
  INNER JOIN "incident_messages" AS "message"
    ON "message"."tenant_id" = "binding"."tenant_id"
   AND "message"."incident_id" = "binding"."incident_id"
   AND "message"."origin_message_id" = 'correlated-source:' || "binding"."surface" || ':' || "binding"."external_id"
  WHERE ("primary"."channel" IS NULL OR "primary"."channel" = "binding"."channel")
    AND "working"."id" IS NULL
  ORDER BY "binding"."tenant_id", "binding"."incident_id", "binding"."surface",
           "message"."created_at" DESC, "binding"."created_at" DESC, "binding"."id" DESC;--> statement-breakpoint
UPDATE "surface_bindings" AS "binding"
SET "role" = 'source', "projection_mode" = 'status'
FROM "sre_0027_latest_correlated" AS "latest"
WHERE "binding"."tenant_id" = "latest"."tenant_id"
  AND "binding"."incident_id" = "latest"."incident_id"
  AND "binding"."surface" = "latest"."surface"
  AND "binding"."role" = 'primary'
  AND "binding"."id" <> "latest"."id";--> statement-breakpoint
UPDATE "surface_bindings" AS "binding"
SET "role" = 'primary', "projection_mode" = 'full'
FROM "sre_0027_latest_correlated" AS "latest"
WHERE "binding"."tenant_id" = "latest"."tenant_id"
  AND "binding"."id" = "latest"."id";--> statement-breakpoint
DROP TABLE "sre_0027_latest_correlated";
