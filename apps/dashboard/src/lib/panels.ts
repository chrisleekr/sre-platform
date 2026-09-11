import type { PanelDef } from './types';

export const PANELS: PanelDef[] = [
  { path: '/w', label: 'Dashboard', group: 'Respond' },
  { path: '/w/incidents', label: 'Incidents', group: 'Respond' },
  { path: '/w/signals', label: 'Signals', group: 'Respond' },
  { path: '/w/infrastructure', label: 'Infrastructure', group: 'Observe' },
  { path: '/w/deployments', label: 'Deployments', group: 'Observe' },
  { path: '/w/changes', label: 'Changes', group: 'Observe' },
  { path: '/w/topology', label: 'Topology', group: 'Observe' },
  { path: '/w/reliability', label: 'Reliability', group: 'Observe' },
  { path: '/w/error-budgets', label: 'Error budgets', group: 'Observe' },
  { path: '/w/connectors', label: 'Connections', group: 'Configure' },
  { path: '/w/surfaces', label: 'Inbound', group: 'Configure' },
  { path: '/w/usage', label: 'Usage & Cost', group: 'Configure' },
  { path: '/w/settings', label: 'Settings', group: 'Configure' },
];
