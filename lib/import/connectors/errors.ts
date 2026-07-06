// Typed connector errors (Story 7.16 · MOTIR-1501). A connector translates a
// raw transport failure (a non-2xx HTTP status, a network throw, an unparseable
// file, bad config) into ONE of these so callers branch on a stable `code`
// instead of sniffing HTTP internals — the same "raw errors never escape the
// layer" discipline `motir-core/CLAUDE.md` requires of services. Fatal (they
// abort connect / a page); a single bad ISSUE is a `SourceIssueError`, not one
// of these.

export type ConnectorErrorCode =
  | 'CONNECTOR_CONFIG'
  | 'CONNECTOR_AUTH'
  | 'CONNECTOR_HTTP'
  | 'CONNECTOR_PARSE';

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  /** The source, when known — aids the wizard's error copy. */
  readonly source?: string;
  constructor(code: ConnectorErrorCode, message: string, source?: string) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.source = source;
  }
}

/** Bad / missing configuration (no token, no owner/repo, empty file) — a
 *  user-fixable input error, distinct from a transport failure. */
export class ConnectorConfigError extends ConnectorError {
  constructor(message: string, source?: string) {
    super('CONNECTOR_CONFIG', message, source);
    this.name = 'ConnectorConfigError';
  }
}

/** 401 / 403 from the source — credentials rejected or scope insufficient.
 *  Never retried (a retry cannot fix an auth failure). */
export class ConnectorAuthError extends ConnectorError {
  readonly status: number;
  constructor(status: number, message: string, source?: string) {
    super('CONNECTOR_AUTH', message, source);
    this.name = 'ConnectorAuthError';
    this.status = status;
  }
}

/** A non-2xx that isn't auth (404, a persistent 5xx after retries, a 4xx). */
export class ConnectorHttpError extends ConnectorError {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, message: string, source?: string) {
    super('CONNECTOR_HTTP', message, source);
    this.name = 'ConnectorHttpError';
    this.status = status;
    this.url = url;
  }
}

/** The file could not be parsed at all (not a per-row problem — the whole
 *  file). Per-row issues are `SourceIssueError`s, not this. */
export class ConnectorParseError extends ConnectorError {
  constructor(message: string, source?: string) {
    super('CONNECTOR_PARSE', message, source);
    this.name = 'ConnectorParseError';
  }
}
