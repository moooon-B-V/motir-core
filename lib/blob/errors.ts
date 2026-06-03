// Typed errors for the attachment-upload domain (Subtask 2.3.7). The route maps
// each `code` to an HTTP status, matching the `readonly code` convention the
// other domains use.

export abstract class AttachmentError extends Error {
  abstract readonly code: string;
  /** HTTP status the route should return. */
  abstract readonly status: number;
}

/** Upload exceeded the size cap. → 413. */
export class FileTooLargeError extends AttachmentError {
  readonly code = 'FILE_TOO_LARGE' as const;
  readonly status = 413;
  constructor(maxBytes: number) {
    super(`File is too large — the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
    this.name = 'FileTooLargeError';
  }
}

/** MIME type not in the allowlist. → 415. */
export class UnsupportedFileTypeError extends AttachmentError {
  readonly code = 'UNSUPPORTED_FILE_TYPE' as const;
  readonly status = 415;
  constructor(mime: string) {
    super(`File type "${mime || 'unknown'}" isn't supported.`);
    this.name = 'UnsupportedFileTypeError';
  }
}

/** Per-user upload rate limit exceeded. → 429. */
export class RateLimitError extends AttachmentError {
  readonly code = 'RATE_LIMITED' as const;
  readonly status = 429;
  constructor() {
    super('Too many uploads — please wait a moment and try again.');
    this.name = 'RateLimitError';
  }
}
