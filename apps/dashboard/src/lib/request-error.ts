/** An API rejection that is safe to present as text at the action that failed. */
export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

/**
 * Reject unsuccessful responses without exposing proxy pages or server exception bodies.
 * @param response - Platform API response, not an upstream provider response.
 * @param fallback - Action-specific message for unavailable or unexpected failures.
 * @param publicMessages - Local guidance for documented provider failure codes, including 5xx.
 */
export async function checkResponse(
  response: Response,
  fallback: string,
  publicMessages: Readonly<Record<string, string>> = {},
): Promise<void> {
  if (response.ok) return;
  const body: unknown = await response.json().catch(() => null);
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const publicMessage =
    typeof fields.code === 'string' && Object.hasOwn(publicMessages, fields.code)
      ? publicMessages[fields.code]
      : undefined;
  let message = publicMessage ?? fallback;
  let code: string | undefined;
  // Client rejections are the API's validation contract. Server failures may contain exceptions.
  if (response.status >= 400 && response.status < 500) {
    const error = fields.error;
    if (
      typeof error === 'string' &&
      !publicMessage &&
      error.trim() &&
      error.length <= 600 &&
      !/^[a-z][a-z0-9_]*$/.test(error.trim()) &&
      !/[<>\p{Cc}]/u.test(error)
    )
      message = error.trim();
    if (message === 'a data source with this name already exists') {
      code = 'duplicate_data_source_name';
      message =
        'A data source with this name already exists. Choose a different data source name, or manage the existing connection.';
    }
    if (response.status === 401) message = 'Your session expired. Sign in again, then retry.';
    if (response.status === 403 && (message === fallback || message === 'forbidden'))
      message = 'You do not have permission for this action. Ask your workspace administrator.';
    if (response.status === 429)
      message =
        message === fallback
          ? 'Too many requests. Wait a moment, then retry.'
          : `${message} Wait a moment, then retry.`;
  }
  const reference = fields.reference;
  if (typeof reference === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(reference))
    message += ` Diagnostic reference: ${reference}.`;
  throw new RequestError(message, response.status, code);
}

/**
 * Keep API guidance while hiding arbitrary runtime and network exception text.
 * @param error - Rejected action or request.
 * @param fallback - Safe recovery instruction for unclassified failures.
 */
export function requestErrorMessage(error: unknown, fallback: string): string {
  return error instanceof RequestError ? error.message : fallback;
}
