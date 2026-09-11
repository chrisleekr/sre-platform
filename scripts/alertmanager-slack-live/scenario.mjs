import { randomUUID } from 'node:crypto';
import { createDeliveryChecks } from './delivery.mjs';

export async function runScenario({
  alertmanagerImage,
  eventually,
  jsonRequest,
  startAlertmanager,
  startIsolatedPlatform,
}) {
  let apiBaseUrl = '';
  let authHeaders = {};

  async function sessionToken(email, password) {
    const { body } = await jsonRequest(
      `${apiBaseUrl}/auth/local/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      },
      [200],
      'local login',
    );
    if (!body || typeof body.token !== 'string') throw new Error('local login returned no token');
    return body.token;
  }

  async function apiGet(path) {
    return (
      await jsonRequest(`${apiBaseUrl}${path}`, { headers: authHeaders }, [200], `GET ${path}`)
    ).body;
  }

  async function apiPost(path, body) {
    return (
      await jsonRequest(
        `${apiBaseUrl}${path}`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        [200],
        `POST ${path}`,
      )
    ).body;
  }

  const { assertNoSlackDeliveryTargetAfter, waitForAcceptedLifecycleBinding } =
    createDeliveryChecks(apiGet, eventually);

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const title = `SRE lifecycle E2E ${runId}`;
  const firstStartsAt = new Date().toISOString();

  async function submitAlert(
    alertmanagerBaseUrl,
    startsAt,
    description,
    endsAt,
    { alertName = title, service = 'sre-platform-e2e' } = {},
  ) {
    const firingEndsAt = new Date(new Date(startsAt).getTime() + 60 * 60_000).toISOString();
    await jsonRequest(
      `${alertmanagerBaseUrl}/api/v2/alerts`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            labels: { alertname: alertName, service, severity: 'info' },
            annotations: { summary: alertName, description },
            startsAt,
            endsAt: endsAt || firingEndsAt,
            generatorURL: `https://prometheus.example.invalid/graph?e2e=${runId}`,
          },
        ]),
      },
      [200],
      'Alertmanager alerts API',
    );
  }

  async function matchingIncidents() {
    const body = await apiGet('/incidents');
    return (body?.incidents || [])
      .filter((incident) => incident.title === title)
      .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async function incidentWithTitle(expectedTitle) {
    const body = await apiGet('/incidents');
    return (body?.incidents || []).find((incident) => incident.title === expectedTitle) || null;
  }

  async function workspace(incidentId) {
    return apiGet(`/incidents/${incidentId}/workspace`);
  }

  async function waitForAssessment(incidentId) {
    return eventually(`incident ${incidentId} assessment`, async () => {
      const current = await workspace(incidentId);
      return current?.incident?.investigationStatus === 'assessed' ||
        current?.incident?.investigationStatus === 'degraded'
        ? current
        : null;
    });
  }

  async function waitForSlackPermalink(incidentId) {
    return eventually(`incident ${incidentId} Slack root`, async () => {
      const body = await apiGet(`/incidents/${incidentId}/slack-permalink`);
      return typeof body?.permalink === 'string' && body.permalink ? body.permalink : null;
    });
  }

  async function waitForDashboardOnlyRelationship(incidentId, originPrefix) {
    return eventually(`incident ${incidentId} dashboard relationship`, async () => {
      const body = await apiGet(`/incidents/${incidentId}/messages?limit=200`);
      return (body?.messages || []).find(
        (message) =>
          message.kind === 'relationship' &&
          message.originMessageId?.startsWith(originPrefix) &&
          (message.slackDeliveries || []).length === 0,
      );
    });
  }

  async function waitForCorrectionLifecycleDelivery(
    incidentId,
    expectedBindings,
    originPrefix,
    requiredAcceptedBindingIds,
  ) {
    const requiredBindings = new Set(requiredAcceptedBindingIds);
    return eventually(`incident ${incidentId} lifecycle correction projection`, async () => {
      const body = await apiGet(`/incidents/${incidentId}/messages?limit=200`);
      return (body?.messages || []).find(
        (message) =>
          message.kind === 'lifecycle' &&
          message.originMessageId?.startsWith(originPrefix) &&
          message.slackDeliveries?.length === expectedBindings &&
          new Set(message.slackDeliveries.map((delivery) => delivery.bindingId)).size ===
            expectedBindings &&
          message.slackDeliveries.every((delivery) =>
            ['accepted', 'skipped'].includes(delivery.state),
          ) &&
          [...requiredBindings].every((bindingId) =>
            message.slackDeliveries.some(
              (delivery) =>
                delivery.bindingId === bindingId &&
                delivery.state === 'accepted' &&
                delivery.remoteMessageId,
            ),
          ),
      );
    });
  }

  async function retryCorrection(path, body) {
    return eventually(path, async () => {
      const result = await jsonRequest(
        `${apiBaseUrl}${path}`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        [200, 409],
        path,
      );
      return result.response.status === 200 ? result.body : null;
    });
  }

  async function closeIncident(incidentId) {
    const current = await workspace(incidentId);
    if (current?.incident?.status !== 'closed')
      await apiPost(`/incidents/${incidentId}/lifecycle`, {
        to: 'closed',
        reason:
          'Close the completed synthetic Alertmanager and Slack lifecycle acceptance incident.',
        requestId: randomUUID(),
        expectedVersion: current.incident.lifecycleVersion,
      });
    return eventually(`incident ${incidentId} close`, async () => {
      const latest = await workspace(incidentId);
      return latest?.incident?.status === 'closed' ? latest : null;
    });
  }

  const initialDescription = `Initial firing for ${runId}`;
  const platform = await startIsolatedPlatform(runId);
  let alertmanager;
  const cleanupIncidentIds = [];
  try {
    apiBaseUrl = platform.apiBaseUrl;
    authHeaders = {
      authorization: `Bearer ${await sessionToken(platform.localEmail, platform.localPassword)}`,
    };
    alertmanager = await startAlertmanager(
      runId,
      platform.containerDeliveryUrl,
      platform.eventToken,
    );
    await submitAlert(alertmanager.baseUrl, firstStartsAt, initialDescription);
    const firstIncident = await eventually('first incident creation', async () => {
      const incidents = await matchingIncidents();
      return incidents[0] || null;
    });
    cleanupIncidentIds.push(firstIncident.id);
    const firstPermalink = await waitForSlackPermalink(firstIncident.id);
    const firstBindingId = await waitForAcceptedLifecycleBinding(firstIncident.id, 'open');
    const firstAssessed = await waitForAssessment(firstIncident.id);
    const firstSignal = firstAssessed.signals?.[0];
    if (firstSignal?.provider !== 'alertmanager' || firstSignal?.state !== 'firing')
      throw new Error('first incident has no firing Alertmanager signal');
    if (firstSignal.materialHash !== firstSignal.lastInvestigatedMaterialHash)
      throw new Error('opening material was not assessed');
    const initialRun = firstAssessed.incident.latestInvestigationRun;
    if (!initialRun?.id || initialRun.operation !== 'investigate' || !initialRun.completedAt)
      throw new Error('opening incident recorded no completed investigation run');

    const symptomTitle = `${title} downstream`;
    const symptomStartsAt = new Date(Date.now() + 500).toISOString();
    const symptomDescription = `Downstream symptom for ${runId}`;
    await submitAlert(alertmanager.baseUrl, symptomStartsAt, symptomDescription, undefined, {
      alertName: symptomTitle,
      service: 'sre-platform-e2e-downstream',
    });
    const symptomIncident = await eventually('causal symptom incident creation', () =>
      incidentWithTitle(symptomTitle),
    );
    cleanupIncidentIds.push(symptomIncident.id);
    const symptomPermalink = await waitForSlackPermalink(symptomIncident.id);
    const symptomBindingId = await waitForAcceptedLifecycleBinding(symptomIncident.id, 'open');
    await waitForAssessment(symptomIncident.id);
    if (symptomPermalink === firstPermalink)
      throw new Error('causal symptom reused the source alert Slack root');

    await submitAlert(alertmanager.baseUrl, firstStartsAt, initialDescription);
    const repeated = await eventually('exact Alertmanager transport repeat', async () => {
      const current = await workspace(firstIncident.id);
      const signal = current?.signals?.[0];
      return signal?.version === firstSignal.version &&
        new Date(signal.lastSeenAt).getTime() > new Date(firstSignal.lastSeenAt).getTime()
        ? current
        : null;
    });
    if (repeated.incident.latestInvestigationRun?.id !== initialRun.id)
      throw new Error('exact transport repeat triggered another investigation run');

    const changedDescription = `Materially changed firing for ${runId}`;
    await submitAlert(alertmanager.baseUrl, firstStartsAt, changedDescription);
    const reassessed = await eventually('material reassessment', async () => {
      const current = await workspace(firstIncident.id);
      const signal = current?.signals?.[0];
      const latestRun = current?.incident?.latestInvestigationRun;
      return signal?.version > firstSignal.version &&
        signal.materialHash === signal.lastInvestigatedMaterialHash &&
        signal.lastInvestigatedVersion === signal.version &&
        latestRun?.id !== initialRun.id &&
        latestRun?.operation === 'reassess' &&
        latestRun?.completedAt
        ? current
        : null;
    });

    const causal = await eventually('evidence-backed causal response root', async () => {
      const [root, symptom] = await Promise.all([
        workspace(firstIncident.id),
        workspace(symptomIncident.id),
      ]);
      const relation = (root?.relations || []).find(
        (candidate) =>
          candidate.type === 'caused_by' &&
          candidate.sourceIncidentId === symptomIncident.id &&
          candidate.targetIncidentId === firstIncident.id,
      );
      return relation ? { relation, root, symptom } : null;
    });
    if (causal.relation.targetIncidentId !== firstIncident.id)
      throw new Error('the source alert did not retain response-root ownership');

    const symptomEndsAt = new Date(Date.now() - 1_000).toISOString();
    await submitAlert(alertmanager.baseUrl, symptomStartsAt, symptomDescription, symptomEndsAt, {
      alertName: symptomTitle,
      service: 'sre-platform-e2e-downstream',
    });
    await eventually('child recovery waits for the response root', async () => {
      const [root, symptom] = await Promise.all([
        workspace(firstIncident.id),
        workspace(symptomIncident.id),
      ]);
      return symptom?.signals?.[0]?.state === 'resolved' && root?.incident?.status === 'open'
        ? { root, symptom }
        : null;
    });

    const endsAt = new Date(Date.now() - 1_000).toISOString();
    await submitAlert(alertmanager.baseUrl, firstStartsAt, changedDescription, endsAt);
    const recovered = await eventually('complete causal-group recovery verification', async () => {
      const [root, symptom] = await Promise.all([
        workspace(firstIncident.id),
        workspace(symptomIncident.id),
      ]);
      return root?.signals?.[0]?.state === 'resolved' &&
        root?.incident?.recoveryState === 'verified' &&
        root?.incident?.status === 'resolved' &&
        symptom?.incident?.status === 'resolved'
        ? { root, symptom }
        : null;
    });
    await Promise.all([
      waitForAcceptedLifecycleBinding(firstIncident.id, 'resolved', firstBindingId),
      waitForAcceptedLifecycleBinding(symptomIncident.id, 'resolved', symptomBindingId),
    ]);
    await apiPost(`/incidents/${symptomIncident.id}/unrelated`, {
      targetIncidentId: firstIncident.id,
      rationale:
        'Acceptance correction: release the synthetic causal response group after recovery.',
      evidence: [`e2e_run:${runId}`, 'verification:causal-rejection-is-reversible'],
    });
    await eventually('causal correction to unrelated', async () => {
      const current = await workspace(symptomIncident.id);
      return (current?.relations || []).some(
        (relation) =>
          relation.type === 'unrelated' && relation.targetIncidentId === firstIncident.id,
      )
        ? current
        : null;
    });
    const refireSubmittedAt = Date.now();
    const secondStartsAt = new Date(Date.now() + 1_000).toISOString();
    await submitAlert(alertmanager.baseUrl, secondStartsAt, `Refired episode for ${runId}`);
    const secondIncident = await eventually('refired incident creation', async () => {
      const incidents = await matchingIncidents();
      return incidents.find((incident) => incident.id !== firstIncident.id) || null;
    });
    cleanupIncidentIds.push(secondIncident.id);
    const secondPermalink = await waitForSlackPermalink(secondIncident.id);
    const secondAssessed = await waitForAssessment(secondIncident.id);
    const secondSignal = secondAssessed.signals?.[0];
    if (
      secondSignal?.providerFingerprint !== firstSignal.providerFingerprint ||
      secondSignal?.startsAt === firstSignal.startsAt
    )
      throw new Error('refire did not preserve provider identity as a distinct episode');
    if (secondPermalink === firstPermalink)
      throw new Error(
        'refired episode reused the prior Slack root instead of opening a new thread',
      );
    const recurrence = (secondAssessed.relations || []).find(
      (relation) =>
        relation.type === 'recurrence_of' &&
        relation.targetIncidentId === firstIncident.id &&
        relation.sourceIncidentId === secondIncident.id,
    );
    if (!recurrence)
      throw new Error('refired incident has no recurrence link to the prior episode');
    await waitForDashboardOnlyRelationship(firstIncident.id, 'alertmanager:relationship-backlink:');
    await waitForDashboardOnlyRelationship(secondIncident.id, 'alertmanager:relationships:');
    await assertNoSlackDeliveryTargetAfter(firstIncident.id, firstBindingId, refireSubmittedAt);

    const mergeResult = await retryCorrection(`/incidents/${firstIncident.id}/merge`, {
      targetIncidentId: secondIncident.id,
      rationale:
        'Live acceptance test: both generated episodes represent the same synthetic condition.',
      evidence: [`e2e_run:${runId}`, `provider_fingerprint:${firstSignal.providerFingerprint}`],
    });
    const transferredBindingIds = mergeResult?.relation?.correction?.bindingIds;
    if (!Array.isArray(transferredBindingIds) || transferredBindingIds.length === 0)
      throw new Error('merge response did not identify the transferred source bindings');
    await waitForDashboardOnlyRelationship(secondIncident.id, 'incident-merge:');
    await waitForCorrectionLifecycleDelivery(
      secondIncident.id,
      2,
      'incident-merge-lifecycle:',
      transferredBindingIds,
    );
    const merged = await eventually('merged dashboard projection', async () => {
      const current = await workspace(secondIncident.id);
      return current?.signals?.length === 2 &&
        (current.relations || []).some(
          (relation) =>
            relation.type === 'merged_into' && relation.sourceIncidentId === firstIncident.id,
        )
        ? current
        : null;
    });

    const splitResult = await retryCorrection(`/incidents/${firstIncident.id}/split`, {
      targetIncidentId: secondIncident.id,
      rationale:
        'Live acceptance test: restore independent episode ownership after merge verification.',
      evidence: [`e2e_run:${runId}`, 'verification:split-restores-membership'],
    });
    const restoredBindingIds = splitResult?.relation?.correction?.bindingIds;
    if (!Array.isArray(restoredBindingIds) || restoredBindingIds.length === 0)
      throw new Error('split response did not identify the restored source bindings');
    const split = await eventually('split dashboard projection', async () => {
      const [first, second] = await Promise.all([
        workspace(firstIncident.id),
        workspace(secondIncident.id),
      ]);
      return first?.signals?.length === 1 &&
        second?.signals?.length === 1 &&
        (first.relations || []).some((relation) => relation.type === 'split_from') &&
        (first.relations || []).some((relation) => relation.type === 'recurrence_of')
        ? { first, second }
        : null;
    });
    await Promise.all([
      waitForDashboardOnlyRelationship(firstIncident.id, 'incident-split:'),
      waitForDashboardOnlyRelationship(secondIncident.id, 'incident-split:'),
      waitForCorrectionLifecycleDelivery(
        firstIncident.id,
        1,
        'incident-split-lifecycle:',
        restoredBindingIds,
      ),
    ]);

    const secondEndsAt = new Date(Date.now() - 1_000).toISOString();
    await submitAlert(
      alertmanager.baseUrl,
      secondStartsAt,
      `Refired episode for ${runId}`,
      secondEndsAt,
    );
    const secondRecovered = await eventually('refired episode recovery verification', async () => {
      const current = await workspace(secondIncident.id);
      const signal = current?.signals?.[0];
      return signal?.state === 'resolved' &&
        ['verified', 'not_verified'].includes(current?.incident?.recoveryState)
        ? current
        : null;
    });
    const [closedFirst, closedSecond, closedSymptom] = await Promise.all([
      closeIncident(firstIncident.id),
      closeIncident(secondIncident.id),
      closeIncident(symptomIncident.id),
    ]);

    console.log(
      JSON.stringify(
        {
          ok: true,
          runId,
          alertmanagerImage,
          firstIncidentId: firstIncident.id,
          secondIncidentId: secondIncident.id,
          firstPermalink,
          secondPermalink,
          exactRepeatRunId: initialRun.id,
          reassessmentRunId: reassessed.incident.latestInvestigationRun.id,
          symptomIncidentId: symptomIncident.id,
          symptomPermalink,
          causalRelationId: causal.relation.id,
          recoveryState: recovered.root.incident.recoveryState,
          recoveryLifecycle: recovered.root.incident.status,
          refireRecoveryState: secondRecovered.incident.recoveryState,
          mergedSignalCount: merged.signals.length,
          splitSignalCounts: [split.first.signals.length, split.second.signals.length],
          finalLifecycles: [
            closedFirst.incident.status,
            closedSecond.incident.status,
            closedSymptom.incident.status,
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled(
      [...new Set(cleanupIncidentIds)].map(async (id) => {
        const current = await workspace(id);
        if (current?.incident?.status !== 'closed')
          await apiPost(`/incidents/${id}/lifecycle`, {
            to: 'closed',
            reason: 'Clean up an interrupted synthetic Alertmanager and Slack lifecycle test.',
            requestId: randomUUID(),
            expectedVersion: current.incident.lifecycleVersion,
          });
      }),
    );
    await Promise.allSettled([alertmanager?.stop() ?? Promise.resolve(), platform.stop()]);
  }
}
