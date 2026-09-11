ALTER TABLE "incidents" DROP CONSTRAINT "incidents_status_vocabulary";--> statement-breakpoint
DROP INDEX "incidents_active_fingerprint_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_active_fingerprint_uq" ON "incidents" USING btree ("tenant_id","fingerprint") WHERE status in ('open', 'mitigated');--> statement-breakpoint
ALTER TABLE "incidents" DROP COLUMN "acknowledged_at";--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_status_vocabulary" CHECK (status in ('open', 'mitigated', 'resolved', 'closed'));
