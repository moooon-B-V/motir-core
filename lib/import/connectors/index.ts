// Public surface of the issue-importer connector layer (Story 7.16 · MOTIR-1501).
// Downstream stages import the source-agnostic types + the concrete connectors
// from here. The Jira / Linear (MOTIR-940) and Plane (MOTIR-1639) connectors add
// their classes to this barrel as they land.

export type {
  SourceKind,
  SourceIssue,
  SourceComment,
  SourceAttachmentRef,
  SourceLink,
  SourceIssueError,
  SourceIssuePage,
  SourceFieldVocabulary,
  ConnectResult,
  IssueSourceConnector,
} from './types';

export {
  ConnectorError,
  ConnectorConfigError,
  ConnectorAuthError,
  ConnectorHttpError,
  ConnectorParseError,
  type ConnectorErrorCode,
} from './errors';

export {
  fetchWithRetry,
  paginate,
  parseLinkHeader,
  parseRetryAfter,
  backoffDelay,
  queryParam,
  type RetryOptions,
} from './http';

export { CsvConnector, type CsvConnectorConfig, type CsvColumnMap } from './csvConnector';
export { GithubConnector, type GithubConnectorConfig } from './githubConnector';
export { JiraConnector, type JiraConnectorConfig, adfToText } from './jiraConnector';
export { LinearConnector, type LinearConnectorConfig } from './linearConnector';
