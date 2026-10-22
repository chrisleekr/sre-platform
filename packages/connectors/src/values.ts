/** A granular record at an object path, or an empty record when absent. */
export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Coerce an id-like provider value to a string. */
export function idStr(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * Replace a provider file's Base64 `content` with its UTF-8 text so the model reads source directly.
 * Binary or non-UTF-8 content keeps its Base64 form.
 * @param file - A provider file response carrying `encoding: 'base64'` and `content`.
 */
export function decodeBase64Content(file: unknown): unknown {
  const record = obj(file);
  if (record.encoding !== 'base64' || typeof record.content !== 'string') return file;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(record.content.replace(/\s+/g, ''), 'base64'),
    );
  } catch {
    return file;
  }
  return text.includes('\0') ? file : { ...record, encoding: 'utf-8', content: text };
}
