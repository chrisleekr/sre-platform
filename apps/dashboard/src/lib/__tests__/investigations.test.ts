import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createManualIncident,
  investigationSubjectKey,
  listActiveInvestigations,
  type InvestigationSubject,
} from '../investigations';

afterEach(() => vi.unstubAllGlobals());

describe('investigation client identities', () => {
  test('keeps discovered services scoped and maps server identities back to the selected subject', async () => {
    const subject: InvestigationSubject = {
      kind: 'topology_service',
      service: 'checkout',
      subjectKey: 'exact-production-key',
    };
    expect(investigationSubjectKey(subject)).not.toBe(
      investigationSubjectKey({ ...subject, subjectKey: 'exact-development-key' }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          active: [
            {
              kind: 'topology_service',
              sourceId: 'topology-discovery',
              subjectId: 'bounded-hash',
              subjectKey: subject.subjectKey,
              incidentId: 'incident-production',
            },
          ],
        }),
      ),
    );
    const active = await listActiveInvestigations(
      '/api',
      async () => ({ kind: 'bearer', token: 'token' }),
      [subject],
    );
    expect(active.get(investigationSubjectKey(subject))).toBe('incident-production');
  });
  const subjects: InvestigationSubject[] = [
    { kind: 'infrastructure_resource', dataSourceId: 'source-1', entityId: 'ns/pod-1' },
    { kind: 'deployment', deploymentId: 'deployment-1' },
    { kind: 'connector_verification', connectorId: 'connector-1' },
    { kind: 'topology_service', service: 'checkout' },
  ];

  test('keys all four typed identities without collapsing their source scope', () => {
    expect(subjects.map(investigationSubjectKey)).toEqual([
      'infrastructure_resource:source-1:ns/pod-1',
      'deployment:deployment-1',
      'connector_verification:connector-1',
      'topology_service:checkout',
    ]);
  });

  test('posts the exact subject batch and maps every active identity back to its client key', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ subjects });
      return new Response(
        JSON.stringify({
          active: [
            {
              kind: 'infrastructure_resource',
              sourceId: 'source-1',
              subjectId: 'ns/pod-1',
              incidentId: 'incident-1',
            },
            {
              kind: 'deployment',
              sourceId: 'deployment',
              subjectId: 'deployment-1',
              incidentId: 'incident-2',
            },
            {
              kind: 'connector_verification',
              sourceId: 'connector-1',
              subjectId: 'connector-1',
              incidentId: 'incident-3',
            },
            {
              kind: 'topology_service',
              sourceId: 'topology',
              subjectId: 'checkout',
              incidentId: 'incident-4',
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const active = await listActiveInvestigations(
      '/api',
      async () => ({ kind: 'bearer', token: 'token' }),
      subjects,
    );

    expect([...active]).toEqual([
      ['infrastructure_resource:source-1:ns/pod-1', 'incident-1'],
      ['deployment:deployment-1', 'incident-2'],
      ['connector_verification:connector-1', 'incident-3'],
      ['topology_service:checkout', 'incident-4'],
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/incidents/observation-workspaces',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('manual incident client', () => {
  test('posts the responder report with bearer authentication', async () => {
    const draft = {
      requestId: '00000000-0000-4000-8000-000000000123',
      title: 'Checkout latency increased',
      description: 'Latency rose after the latest deployment.',
      service: 'checkout-api',
      severity: 'sev2' as const,
    };
    const fetchMock = vi.fn(async () =>
      Response.json(
        { outcome: 'created', incidentId: '00000000-0000-4000-8000-000000000456' },
        { status: 201 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createManualIncident('/api', async () => ({ kind: 'bearer', token: 'token' }), draft),
    ).resolves.toEqual({
      outcome: 'created',
      incidentId: '00000000-0000-4000-8000-000000000456',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/incidents', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
        'x-sre-session': '1',
      },
      credentials: 'include',
      body: JSON.stringify(draft),
    });
  });

  test('shows safe recovery guidance for an unavailable API', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'incident declaration unavailable' }, { status: 503 }),
      ),
    );

    await expect(
      createManualIncident('/api', async () => ({ kind: 'bearer', token: 'token' }), {
        requestId: '00000000-0000-4000-8000-000000000123',
        title: 'Checkout latency increased',
        description: 'Latency rose after the latest deployment.',
        service: 'checkout-api',
        severity: 'sev2',
      }),
    ).rejects.toThrow('Could not create the incident. Refresh and retry.');
  });
});
