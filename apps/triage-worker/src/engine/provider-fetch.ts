/**
 * Suppresses SDK-level 429 retries without changing retry policy for other responses.
 * Both supported direct SDKs honor x-should-retry before their status-based retry rules.
 * @param input - SDK request destination.
 * @param init - SDK request options, including its cancellation signal.
 */
export async function providerFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status !== 429) return response;
  const headers = new Headers(response.headers);
  headers.set('x-should-retry', 'false');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
