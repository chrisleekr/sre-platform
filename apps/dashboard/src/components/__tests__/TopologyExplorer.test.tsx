// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TopologyExplorer } from '../TopologyExplorer';
import { discoveryFixture } from './topology-discovery.fixture';
import './topology-map-browser.fixture';
vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  return {
    default: class extends ELK {
      constructor() {
        super({ algorithms: ['layered'] });
      }
      override terminateWorker() {}
    },
  };
});

afterEach(cleanup);
beforeEach(() => window.history.replaceState({}, '', '/?view=list'));
afterEach(() => window.history.replaceState({}, '', '/'));
const props = () => ({
  graph: discoveryFixture(),
  loading: false,
  error: false,
  onRefresh: vi.fn(),
});
const list = () => within(screen.getByRole('list', { name: 'Discovered subjects' }));
const detail = () => within(screen.getByRole('region', { name: 'Selected topology subject' }));

test('retains inspected identity and view in the URL across remount without losing unrelated parameters', () => {
  window.history.replaceState({}, '', '/?view=list&incident=existing');
  const input = props();
  const first = render(<TopologyExplorer {...input} />);
  expect(list().getByRole('button', { name: /^checkout-api workload/ }).textContent).toContain(
    'Kubernetes · 1 evidence source',
  );
  fireEvent.click(list().getByRole('button', { name: /^checkout-api workload/ }));
  expect(new URLSearchParams(window.location.search).get('subject')).toBe('api');
  expect(new URLSearchParams(window.location.search).get('incident')).toBe('existing');
  first.unmount();
  render(<TopologyExplorer {...input} />);
  expect(detail().getByRole('heading', { name: 'checkout-api' })).toBeTruthy();
  fireEvent.click(detail().getByRole('button', { name: 'Back to results' }));
  expect(new URLSearchParams(window.location.search).has('subject')).toBe(false);
});

test('distinguishes more scan pages from failures and links failed sources to recovery', () => {
  const input = props();
  input.graph.coverage = [
    {
      connectorId: 'source',
      connectorName: 'Source',
      connectorType: 'gitlab',
      collection: 'repositories',
      completeness: 'partial',
      issue: 'limit',
      observedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
      hasMore: true,
      scanHasGaps: false,
    },
  ];
  const { rerender } = render(<TopologyExplorer {...input} />);
  expect(screen.getByText('More pages available')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Review Source connection' })).toBeNull();
  input.graph.coverage[0]!.issue = 'permission_denied';
  rerender(<TopologyExplorer {...input} />);
  expect(screen.getByRole('link', { name: 'Review Source connection' }).getAttribute('href')).toBe(
    '/w/connectors?connection=source',
  );
});

test('consolidates matching provenance while preserving distinct revisions and individual facts', () => {
  const input = props();
  const original = input.graph.relations.find((row) => row.key === 'deployment')!;
  input.graph.relations.push(
    { ...original, key: 'deployment-two', from: { ...original.from, id: 'other-resource' } },
    {
      ...original,
      key: 'deployment-new',
      attributes: { ...original.attributes, revision: 'b'.repeat(40) },
    },
  );
  input.graph.operational.relations
    .find((row) => row.kind === 'deployed_from')!
    .evidenceKeys.push('deployment-two', 'deployment-new');
  render(<TopologyExplorer {...input} />);
  fireEvent.click(list().getByRole('button', { name: /^checkout-api workload/ }));
  expect(detail().getAllByText(original.description)).toHaveLength(2);
  expect(detail().getByText('2 resource relationships')).toBeTruthy();
  expect(detail().getByText('b'.repeat(40))).toBeTruthy();
});

test('explains a rejected discovery query without claiming the provider is unreachable', () => {
  const input = props();
  input.graph.coverage = [
    {
      connectorId: 'datadog',
      connectorName: 'Datadog',
      connectorType: 'datadog',
      collection: '__discovery__',
      completeness: 'unavailable',
      issue: 'request_rejected',
      observedAt: new Date().toISOString(),
      attemptedAt: new Date().toISOString(),
    },
  ];
  render(<TopologyExplorer {...input} />);
  fireEvent.click(screen.getByText(/Discovery coverage/));
  expect(screen.getByText(/Source rejected the discovery query/)).toBeTruthy();
  expect(screen.queryByText(/Source could not be reached/)).toBeNull();
  expect(list().getAllByRole('button')).toHaveLength(5);
});

test('explores identities without a catalog and never conflates equal names across environments', () => {
  render(<TopologyExplorer {...props()} />);
  expect(list().getAllByRole('button')).toHaveLength(5);
  fireEvent.click(
    list().getByRole('button', { name: /checkout service · environment: production/ }),
  );
  expect(detail().getByText('production')).toBeTruthy();
  expect(detail().queryByText('development')).toBeNull();
  expect(detail().getByRole('button', { name: 'checkout-api' })).toBeTruthy();
  fireEvent.click(
    list().getByRole('button', { name: /checkout service · environment: development/ }),
  );
  expect(detail().getByText(/Evidence is stale/)).toBeTruthy();
  expect(detail().getByText(/No resolved relationships/)).toBeTruthy();
  expect(screen.queryByText(/Healthy/)).toBeNull();
});

test('follows directional neighbours and exposes relation evidence rather than pretending every edge is a call', () => {
  render(<TopologyExplorer {...props()} />);
  fireEvent.click(list().getByRole('button', { name: /^checkout-api workload/ }));
  const relationships = detail().getByRole('list', { name: 'Subject relationships' });
  expect(relationships.textContent).toContain('runs on');
  expect(relationships.textContent).toContain('deployed from');
  expect(relationships.textContent).toContain('monitors');
  fireEvent.click(within(relationships).getByText('Declared · Inspect evidence'));
  expect(within(relationships).getByText(/Deployment configuration source/)).toBeTruthy();
  expect(within(relationships).getByText(/path: apps\/checkout/)).toBeTruthy();
  expect(within(relationships).getByText('Deployment configuration', { exact: true })).toBeTruthy();
  expect(within(relationships).getByText('a'.repeat(40), { exact: true })).toBeTruthy();
  expect(within(relationships).getByText(/GitLab · inventory · complete/)).toBeTruthy();
  fireEvent.click(detail().getByRole('button', { name: 'team/platform-config' }));
  expect(detail().getByRole('heading', { name: 'team/platform-config' })).toBeTruthy();
  expect(document.activeElement).toBe(
    detail().getByRole('heading', { name: 'team/platform-config' }),
  );
  fireEvent.click(detail().getByRole('button', { name: 'Back to results' }));
  expect(screen.queryByRole('region', { name: 'Selected topology subject' })).toBeNull();
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Discovery results');
});

test('filters by kind, connection and explicit scope, and restores results after clearing', () => {
  render(<TopologyExplorer {...props()} />);
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'service' } });
  expect(list().getAllByRole('button')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('Scope'), {
    target: { value: JSON.stringify(['environment', 'production']) },
  });
  expect(list().getAllByRole('button')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Connection'), { target: { value: 'GitLab' } });
  expect(list().queryAllByRole('button')).toHaveLength(0);
  expect(screen.getByText('No subjects match these filters.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  expect(list().getAllByRole('button')).toHaveLength(5);
});

test('a failing refresh retains evidence and exposes collection gaps and ambiguous identities', () => {
  const input = props();
  input.graph.conflicts.push({ ref: input.graph.entities[0]!.ref, reason: 'ambiguous_reference' });
  render(<TopologyExplorer {...input} error />);
  expect(screen.getByRole('alert').textContent).toContain('last successful discovery snapshot');
  expect(list().getAllByRole('button')).toHaveLength(5);
  fireEvent.click(screen.getByText(/Discovery coverage/));
  expect(screen.getByText(/Sampled telemetry/)).toBeTruthy();
  expect(screen.getByText(/1 identity conflicts remain separate/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh view' }));
  expect(input.onRefresh).toHaveBeenCalledOnce();
});

test('refreshing cannot silently select another resource after the selected identity disappears', () => {
  const input = props();
  const { rerender } = render(<TopologyExplorer {...input} />);
  fireEvent.click(list().getByRole('button', { name: /^checkout-api workload/ }));
  const changed = {
    ...input.graph,
    operational: {
      ...input.graph.operational,
      subjects: input.graph.operational.subjects.filter((item) => item.key !== 'api'),
    },
  };
  rerender(<TopologyExplorer {...input} graph={changed} />);
  expect(screen.queryByRole('region', { name: 'Selected topology subject' })).toBeNull();
  expect(screen.getByText(/This subject is no longer/)).toBeTruthy();
});

test('bounds rendered inventory and clamps the page after collection changes', () => {
  const input = props();
  input.graph.operational.subjects = Array.from({ length: 45 }, (_, index) => ({
    ...input.graph.operational.subjects[0]!,
    key: String(index),
    name: `service-${index}`,
  }));
  const { rerender } = render(<TopologyExplorer {...input} />);
  expect(list().getAllByRole('button')).toHaveLength(20);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(list().getByRole('button', { name: /^service-20 / })).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Search discovered topology'), {
    target: { value: 'service-44' },
  });
  expect(list().getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  rerender(<TopologyExplorer {...props()} />);
  expect(list().getAllByRole('button')).toHaveLength(5);
});

test('empty successful discovery offers connector recovery without demanding manual mapping', () => {
  const input = props();
  input.graph.operational = { subjects: [], relations: [] };
  render(<TopologyExplorer {...input} />);
  expect(screen.getByRole('link', { name: 'Review connections' }).getAttribute('href')).toBe(
    '/w/connectors',
  );
  expect(screen.getByText(/No manual mapping is required/)).toBeTruthy();
});

test('a scoped deep link selects the correct result page without preventing later pagination', () => {
  const input = props();
  input.graph.operational.subjects = Array.from({ length: 45 }, (_, index) => ({
    ...input.graph.operational.subjects[0]!,
    key: String(index),
    name: `service-${index}`,
  }));
  window.history.replaceState({}, '', '/?subject=44&view=list');
  render(<TopologyExplorer {...input} />);
  expect(detail().getByRole('heading', { name: 'service-44' })).toBeTruthy();
  expect(
    list()
      .getByRole('button', { name: /^service-44 / })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(list().getByRole('button', { name: /^service-20 / })).toBeTruthy();
  expect(detail().getByRole('heading', { name: 'service-44' })).toBeTruthy();
});
