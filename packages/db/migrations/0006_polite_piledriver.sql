ALTER TABLE "surface_configs" ADD COLUMN "team_id" text;--> statement-breakpoint
ALTER TABLE "surface_configs" ADD COLUMN "app_id" text;--> statement-breakpoint
ALTER TABLE "surface_configs" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "surface_configs" ADD CONSTRAINT "surface_configs_team_id_uq" UNIQUE("team_id");
