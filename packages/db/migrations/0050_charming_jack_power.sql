ALTER TABLE "incident_tag_suggestions" DROP CONSTRAINT "incident_tag_suggestions_applied_tag_fk";
--> statement-breakpoint
ALTER TABLE "incident_tag_suggestions" ADD CONSTRAINT "incident_tag_suggestions_applied_tag_fk" FOREIGN KEY ("applied_tag_id") REFERENCES "public"."incident_tags"("id") ON DELETE set null ON UPDATE no action;