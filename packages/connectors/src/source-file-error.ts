/** A provider reported that the requested repository file does not exist. */
export class SourceFileNotFoundError extends Error {
  readonly status = 404;
  constructor() {
    super('Repository file not found');
  }
}

/** A source request was rate limited; discovery must stop before reading another repository. */
export class SourceRateLimitError extends Error {
  readonly failureCategory = 'rate_limited';
  constructor() {
    super('Source discovery rate limited');
  }
}
