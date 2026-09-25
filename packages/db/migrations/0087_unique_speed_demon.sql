ALTER TABLE "incident_signals" ADD COLUMN "clear_provenance" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_policy" text DEFAULT 'verified_recovery' NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "resolution_basis" text;--> statement-breakpoint
ALTER TABLE "incident_signals" ADD CONSTRAINT "incident_signals_clear_provenance_check" CHECK ("incident_signals"."clear_provenance" in ('provider', 'operator', 'suppression', 'unknown'));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolution_policy_check" CHECK ("incidents"."resolution_policy" in ('verified_recovery', 'provider_clear'));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolution_basis_check" CHECK ("incidents"."resolution_basis" in ('verified_recovery', 'provider_clear', 'operator'));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_health_check_policy_check" CHECK ("incidents"."purpose" <> 'health_check' or "incidents"."resolution_policy" = 'verified_recovery');