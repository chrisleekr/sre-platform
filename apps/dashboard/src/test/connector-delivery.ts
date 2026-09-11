import type { PrepareDelivery } from '../lib/connector-delivery';

export const prepareTestDelivery: PrepareDelivery = async ({ transport, setupId }) => {
  const id = setupId ?? '00000000-0000-4000-8000-000000000099';
  return {
    setupId: id,
    webhookPath: `/webhooks/github/${id}`,
    ...(transport === 'smee' ? { smeeUrl: 'https://smee.io/prepared-test-channel' } : {}),
  };
};

export const prepareGitLabTestDelivery: PrepareDelivery = async (input) => {
  const result = await prepareTestDelivery(input);
  return { ...result, webhookPath: `/webhooks/gitlab/${result.setupId}` };
};

export const preparePrometheusTestDelivery: PrepareDelivery = async (input) => {
  const result = await prepareTestDelivery(input);
  return { ...result, webhookPath: `/webhooks/alertmanager/${result.setupId}` };
};
