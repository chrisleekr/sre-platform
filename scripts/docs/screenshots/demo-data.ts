/**
 * The demo tenant the documentation screenshots are taken from.
 *
 * Every value is invented. The seed writes only through the platform's own schema and through the
 * atomic incident opener, so a screenshot cannot show a shape the product cannot produce.
 *
 * Timestamps are relative to a caller-supplied `now`, so a re-run reproduces the same relative
 * picture ("14 minutes ago") instead of drifting into "8 months ago".
 */
import { seedChanges, seedDeployments } from './demo-activity';
import { seedAdministration } from './demo-admin';
import { seedConnectors, seedSnapshots, seedTopology, type DemoSeedDeps } from './demo-environment';
import { seedLeadIncident, seedSupportingIncidents } from './demo-incidents';
import { seedNotifications } from './demo-notifications';
import { seedSlackSurface } from './demo-slack';
import { seedUsage } from './demo-usage';

export type { DemoSeedDeps } from './demo-environment';

/**
 * Fills a freshly migrated, empty tenant with the picture the documentation screenshots show.
 *
 * @param deps - Tenant-scoped connections, the queue, the snapshot cache, and the time anchor.
 */
export async function seedDemoData(deps: DemoSeedDeps): Promise<void> {
  await seedSlackSurface(deps);
  await seedTopology(deps);
  const connectors = await seedConnectors(deps);
  await seedSnapshots(deps, connectors);
  await seedDeployments(deps, connectors);
  await seedChanges(deps, connectors);
  const leadIncidentId = await seedLeadIncident(deps);
  await seedSupportingIncidents(deps);
  await seedUsage(deps, leadIncidentId);
  await seedNotifications(deps);
  await seedAdministration(deps);
}
