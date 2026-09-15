import { useState } from 'react';
// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DiscoveredTopologyMap } from '../DiscoveredTopologyMap';
import { discoveryFixture } from './topology-discovery.fixture';
import './topology-map-browser.fixture';
import { datadogEvidenceUrl } from '../../lib/datadog-evidence';
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
test('explains collected but unresolved traffic without asking to enable it again', () => {
  render(
    <DiscoveredTopologyMap
      subjects={[]}
      relations={[]}
      selected={null}
      onSelect={vi.fn()}
      onClear={vi.fn()}
      unresolvedTrafficCount={3}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Runtime traffic' }));
  expect(
    screen.getByText(/3 sampled relationships lack time-valid endpoint identity/),
  ).toBeTruthy();
  expect(screen.queryByText(/Enable traffic discovery/)).toBeNull();
});
test('Datadog evidence links are bounded and provider-confined', () => {
  const attributes = {
    datadogSite: 'ap2.datadoghq.com',
    logQuery: 'kube_namespace:apps pod_name:api',
    windowStart: '2026-09-13T00:00:00Z',
    windowEnd: '2026-09-13T00:05:00Z',
  };
  const url = new URL(datadogEvidenceUrl(attributes)!);
  expect(url.origin).toBe('https://app.ap2.datadoghq.com');
  expect(url.searchParams.get('query')).toBe(attributes.logQuery);
  expect(
    datadogEvidenceUrl({ ...attributes, datadogSite: 'datadoghq.com.evil.example' }),
  ).toBeNull();
  expect(datadogEvidenceUrl({ ...attributes, windowEnd: '2026-09-14T00:00:00Z' })).toBeNull();
});
test('shows runtime calls without pretending workloads are logical services', async () => {
  const graph = discoveryFixture();
  const from = graph.operational.subjects.find((subject) => subject.kind === 'workload')!;
  const to = { ...from, key: 'backend', name: 'backend', kind: 'endpoint' as const };
  const relation = {
    from: from!.key,
    to: to!.key,
    kind: 'calls' as const,
    evidence: 'observed' as const,
    evidenceKeys: ['log'],
    stale: false,
    observedAt: '2026-09-13T00:00:00Z',
    attributes: { parser: 'ingress-nginx', outcome: 'response_recorded' },
  };
  render(
    <DiscoveredTopologyMap
      subjects={[from!, to!]}
      relations={[relation]}
      selected={null}
      onSelect={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: 'Runtime traffic' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  const map = within(await screen.findByRole('group', { name: 'Topology relationships' }));
  fireEvent.click(await map.findByRole('button', { name: /→ calls →/ }));
  expect(screen.getByText(/Response recorded/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Service dependencies' }));
  expect(screen.getByText('No dependency relationships in this view')).toBeTruthy();
});
test('expands a scope, inspects exact identities, and exposes the relationships behind an arrow', async () => {
  const graph = discoveryFixture();
  const onSelect = vi.fn();
  render(
    <DiscoveredTopologyMap
      subjects={graph.operational.subjects}
      relations={graph.operational.relations}
      selected={null}
      onSelect={onSelect}
      onClear={vi.fn()}
    />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: /Open group production.*cluster: cluster-one/ }),
  );
  const map = within(await screen.findByRole('group', { name: 'Topology relationships' }));
  fireEvent.keyDown(await screen.findByRole('button', { name: /Inspect checkout-api/ }), {
    key: 'Enter',
  });
  expect(onSelect).toHaveBeenCalledWith('api');
  const edge = map
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-label')?.includes('deployed from'))!;
  fireEvent.click(edge);
  expect(screen.getByText('deployed from · Declared')).toBeTruthy();
  const details = within(screen.getByRole('region', { name: 'Map relationship details' }));
  expect(
    details.getByRole('button', { name: /checkout-api workload.*cluster: cluster-one/ }),
  ).toBeTruthy();
  expect(
    details.getByRole('button', { name: /team\/platform-config repository.*git.example.test/ }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'All groups' }));
  expect(screen.getByRole('heading', { name: 'Topology overview' })).toBeTruthy();
  fireEvent.click(await screen.findByRole('button', { name: 'Zoom in' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fit all' }));
});

test('returning from a resource inspector restores the expanded group', async () => {
  const graph = discoveryFixture();
  function Explorer() {
    const [selected, setSelected] = useState<string | null>(null);
    return (
      <DiscoveredTopologyMap
        subjects={graph.operational.subjects}
        relations={graph.operational.relations}
        selected={selected}
        onSelect={setSelected}
        onClear={() => setSelected(null)}
        inspector={
          selected ? <button onClick={() => setSelected(null)}>Back to group</button> : undefined
        }
      />
    );
  }
  render(<Explorer />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Open group production.*cluster: cluster-one/ }),
  );
  const heading = screen.getByRole('heading', { name: /resource relationships/ }).textContent;
  fireEvent.click(await screen.findByRole('button', { name: /Inspect checkout-api/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Back to group' }));
  expect(screen.getByRole('heading', { name: /resource relationships/ }).textContent).toBe(heading);
});
