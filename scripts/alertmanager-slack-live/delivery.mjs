export function createDeliveryChecks(apiGet, eventually) {
  async function assertNoSlackDeliveryTargetAfter(incidentId, bindingId, createdAfter) {
    const quietUntil = Date.now() + 6_000;
    const result = await eventually(
      `incident ${incidentId} prior binding stays quiet`,
      async () => {
        const body = await apiGet(`/incidents/${incidentId}/messages?limit=200`);
        const delivery = (body?.messages || [])
          .filter((message) => Date.parse(message.createdAt) >= createdAfter)
          .flatMap((message) => message.slackDeliveries || [])
          .find((candidate) => candidate.bindingId === bindingId);
        if (delivery) return { delivery };
        return Date.now() >= quietUntil ? { delivery: null } : null;
      },
    );
    if (result.delivery)
      throw new Error(
        `the prior Slack binding received a ${result.delivery.state} refire delivery target`,
      );
  }

  async function waitForAcceptedLifecycleBinding(incidentId, lifecycleTo, requiredBindingId) {
    return eventually(`incident ${incidentId} ${lifecycleTo} lifecycle projection`, async () => {
      const body = await apiGet(`/incidents/${incidentId}/messages?limit=200`);
      for (const message of body?.messages || []) {
        if (message.kind !== 'lifecycle' || message.lifecycleTo !== lifecycleTo) continue;
        const delivery = (message.slackDeliveries || []).find(
          (candidate) =>
            candidate.state === 'accepted' &&
            candidate.remoteMessageId &&
            (!requiredBindingId || candidate.bindingId === requiredBindingId),
        );
        if (delivery) return delivery.bindingId;
      }
      return null;
    });
  }

  return { assertNoSlackDeliveryTargetAfter, waitForAcceptedLifecycleBinding };
}
