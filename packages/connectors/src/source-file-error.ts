/** A provider reported that the requested repository file does not exist. */
export class SourceFileNotFoundError extends Error {
  constructor() {
    super('Repository file not found');
  }
}

/** A source request was rate limited; discovery must stop before reading another repository. */
export class SourceRateLimitError extends Error {
  constructor() {
    super('Source discovery rate limited');
  }
}
