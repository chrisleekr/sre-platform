export class WebhookPayloadTooLargeError extends Error {
  constructor() {
    super('webhook payload too large');
    this.name = 'WebhookPayloadTooLargeError';
  }
}

/** Read a webhook body without materializing bytes beyond the route's hard limit. */
export async function readBoundedWebhookBody(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new WebhookPayloadTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
}
