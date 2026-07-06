// The Linear connector (Story 7.16 · MOTIR-940) — GraphQL, Relay-cursor
// paginated (`first` + `after`, loop until `pageInfo.hasNextPage` is false), on
// the shared `IssueSourceConnector` seam + `./http` retry scaffolding
// (MOTIR-1501). Personal API key (Authorization: <key>) or OAuth (Bearer).
//
// Whole-history scope (ADR §1): the `issues` query carries NO state filter, so
// every workflow state — including completed/cancelled (done-category) — is
// returned. `externalId` = the Linear issue identifier (e.g. `ENG-42`).
//
// A GraphQL endpoint answers 200 with an `errors[]` body on failure, so the
// connector inspects the body (not just the HTTP status) and raises a typed
// error. No DB, no Prisma — an external API read only.

import { ConnectorConfigError, ConnectorHttpError } from './errors';
import { fetchWithRetry, type RetryOptions } from './http';
import type {
  ConnectResult,
  IssueSourceConnector,
  SourceComment,
  SourceFieldVocabulary,
  SourceIssue,
  SourceIssueError,
  SourceIssuePage,
} from './types';

export interface LinearConnectorConfig {
  /** A Linear personal API key or an OAuth access token (MOTIR-943). */
  apiKey: string;
  /** `apiKey` (raw `Authorization: <key>`, default) or `bearer` (OAuth). */
  authScheme?: 'apiKey' | 'bearer';
  /** Restrict to one team (its key, e.g. `ENG`) — else every accessible issue. */
  teamKey?: string;
  /** Issues per page (Linear default 50; cap 100). */
  pageSize?: number;
  includeComments?: boolean;
  /** Override the endpoint (default `https://api.linear.app/graphql`). */
  endpoint?: string;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

interface LinearUser {
  email?: string | null;
  name?: string | null;
}
interface LinearIssueNode {
  identifier: string;
  title?: string | null;
  description?: string | null;
  priorityLabel?: string | null;
  state?: { name?: string | null } | null;
  assignee?: LinearUser | null;
  creator?: LinearUser | null;
  labels?: { nodes?: Array<{ name?: string }> } | null;
  parent?: { identifier?: string } | null;
  comments?: {
    nodes?: Array<{ body?: string; user?: LinearUser | null; createdAt?: string | null }>;
  } | null;
  createdAt?: string | null;
  completedAt?: string | null;
  canceledAt?: string | null;
  archivedAt?: string | null;
}
interface LinearIssuesResponse {
  data?: {
    issues?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: LinearIssueNode[];
    };
  };
  errors?: Array<{ message?: string }>;
}

const DEFAULT_ENDPOINT = 'https://api.linear.app/graphql';
const DEFAULT_PAGE_SIZE = 50;

const ISSUE_FIELDS = `
  identifier
  title
  description
  priorityLabel
  state { name }
  assignee { email name }
  creator { email name }
  labels { nodes { name } }
  parent { identifier }
  comments { nodes { body createdAt user { email name } } }
  createdAt
  completedAt
  canceledAt
  archivedAt
`;

export class LinearConnector implements IssueSourceConnector {
  readonly source = 'linear' as const;
  private readonly config: LinearConnectorConfig;
  private readonly endpoint: string;
  private readonly pageSize: number;
  private readonly includeComments: boolean;

  constructor(config: LinearConnectorConfig) {
    if (!config.apiKey) throw new ConnectorConfigError('a Linear API key is required', 'linear');
    this.config = config;
    this.endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
    this.pageSize = Math.min(100, config.pageSize ?? DEFAULT_PAGE_SIZE);
    this.includeComments = config.includeComments ?? true;
  }

  private authHeader(): string {
    return this.config.authScheme === 'bearer'
      ? `Bearer ${this.config.apiKey}`
      : this.config.apiKey;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetchWithRetry(
      this.endpoint,
      {
        method: 'POST',
        headers: { Authorization: this.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      {
        ...this.config.retry,
        source: 'linear',
        fetchImpl: this.config.fetchImpl ?? this.config.retry?.fetchImpl,
      },
    );
    const json = (await res.json()) as { errors?: Array<{ message?: string }> } & T;
    if (json.errors && json.errors.length > 0) {
      throw new ConnectorHttpError(
        200,
        this.endpoint,
        `Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}`,
        'linear',
      );
    }
    return json;
  }

  async connect(): Promise<ConnectResult> {
    // `viewer` validates the token cheaply.
    await this.gql<{ data?: { viewer?: { id?: string } } }>(`query { viewer { id name } }`);
    return { source: 'linear', sourceRef: this.config.teamKey ?? 'linear', issueCount: null };
  }

  async discoverFields(): Promise<SourceFieldVocabulary> {
    const res = await this.gql<{
      data?: {
        workflowStates?: { nodes?: Array<{ name?: string }> };
        issueLabels?: { nodes?: Array<{ name?: string }> };
      };
    }>(
      `query { workflowStates(first: 250) { nodes { name } } issueLabels(first: 250) { nodes { name } } }`,
    );
    const statuses = (res.data?.workflowStates?.nodes ?? [])
      .map((n) => n.name)
      .filter((n): n is string => Boolean(n));
    const labels = (res.data?.issueLabels?.nodes ?? [])
      .map((n) => n.name)
      .filter((n): n is string => Boolean(n));
    return {
      types: [], // Linear has no issue-type field — kind is team/label-derived
      statuses: [...new Set(statuses)].sort(),
      priorities: ['No priority', 'Urgent', 'High', 'Medium', 'Low'], // Linear's fixed scale
      labels: [...new Set(labels)].sort(),
    };
  }

  async listIssues(cursor?: string | null): Promise<SourceIssuePage> {
    const filter = this.config.teamKey
      ? `, filter: { team: { key: { eq: "${this.config.teamKey}" } } }`
      : '';
    const query = `
      query Issues($after: String, $first: Int!) {
        issues(first: $first, after: $after, orderBy: createdAt${filter}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${ISSUE_FIELDS} }
        }
      }`;
    const res = await this.gql<LinearIssuesResponse>(query, {
      after: cursor ?? null,
      first: this.pageSize,
    });
    const conn = res.data?.issues;
    const nodes = conn?.nodes ?? [];
    const errors: SourceIssueError[] = [];
    const issues: SourceIssue[] = [];

    for (const node of nodes) {
      try {
        issues.push(this.mapIssue(node));
      } catch (err) {
        errors.push({ externalId: node.identifier ?? null, message: `map failed: ${String(err)}` });
      }
    }

    const nextCursor = conn?.pageInfo?.hasNextPage ? (conn.pageInfo.endCursor ?? null) : null;
    return { issues, errors, nextCursor };
  }

  private mapIssue(node: LinearIssueNode): SourceIssue {
    const comments: SourceComment[] =
      this.includeComments && node.comments?.nodes
        ? node.comments.nodes.map((c) => ({
            authorEmail: c.user?.email ?? null,
            authorName: c.user?.name ?? null,
            body: c.body ?? '',
            createdAt: c.createdAt ?? null,
          }))
        : [];
    const labels = (node.labels?.nodes ?? [])
      .map((l) => l.name)
      .filter((n): n is string => Boolean(n));

    return {
      externalId: node.identifier,
      title: node.title ?? '',
      descriptionMd: node.description ?? null,
      type: null, // no native type — label/team-derived (resolver)
      status: node.state?.name ?? null,
      priority: node.priorityLabel ?? null,
      assigneeEmail: node.assignee?.email ?? null,
      assigneeName: node.assignee?.name ?? null,
      reporterEmail: node.creator?.email ?? null,
      reporterName: node.creator?.name ?? null,
      labels,
      comments,
      attachments: [], // Linear attachments live on a separate connection — not in this slice
      parentExternalId: node.parent?.identifier ?? null,
      links: [],
      createdAt: node.createdAt ?? null,
      closedAt: node.completedAt ?? node.canceledAt ?? node.archivedAt ?? null,
    };
  }
}
