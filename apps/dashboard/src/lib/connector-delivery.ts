import { checkResponse } from './request-error';
import { authenticatedFetch } from './authenticatedFetch';
import type { CredentialGetter } from './request-credentials';

export interface PreparedDelivery {
  setupId: string;
  webhookPath: string;
  smeeUrl?: string;
}
export type PrepareDelivery = (input: {
  transport: 'direct' | 'smee';
  setupId?: string;
}) => Promise<PreparedDelivery>;

export async function prepareConnectorDelivery(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  type: 'github' | 'gitlab' | 'prometheus',
  input: Parameters<PrepareDelivery>[0],
): Promise<PreparedDelivery> {
  const response = await authenticatedFetch(
    `${apiBaseUrl}/connectors/${type}/prepare-delivery`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  );
  await checkResponse(
    response,
    'Could not prepare the webhook address. Retry when the service is available.',
  );
  return (await response.json()) as PreparedDelivery;
}
