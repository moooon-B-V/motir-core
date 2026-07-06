// The Jira connector (Story 7.16 · MOTIR-940) — the richest live-API source.
// REST issue-search, offset-paginated (`startAt` + `maxResults`), on the shared
// `IssueSourceConnector` seam + the `./http` paginate/retry scaffolding
// established by MOTIR-1501. Cloud (Basic email:token) OR OAuth/Server (Bearer).
//
// Whole-history scope (ADR §1): the JQL carries NO `status`/`resolution` clause,
// so every state — open AND resolved/closed — is returned; a closed issue
// reaches the resolver with its real status (mapped to a done-category
// workflow_status). `externalId` = the Jira key.
//
// Descriptions/comments in Jira Cloud v3 are ADF (Atlassian Document Format)
// JSON, not markdown — `adfToText` flattens them to best-effort plain text.
//
// No DB, no Prisma — an external API read only.

import { ConnectorConfigError } from './errors';
import { fetchWithRetry, type RetryOptions } from './http';
import type {
  ConnectResult,
  IssueSourceConnector,
  SourceAttachmentRef,
  SourceComment,
  SourceFieldVocabulary,
  SourceIssue,
  SourceIssueError,
  SourceIssuePage,
  SourceLink,
} from './types';

export interface JiraConnectorConfig {
  /** e.g. `https://your-domain.atlassian.net` (Cloud) or a Server base URL. */
  baseUrl: string;
  /** The API token / OAuth access token (MOTIR-943). */
  apiToken: string;
  /** When set → Basic `email:apiToken` (Jira Cloud API-token auth). When
   *  omitted → Bearer `apiToken` (OAuth 3LO / Server PAT). */
  email?: string;
  /** Restrict to one project (its key) — else the whole accessible instance. */
  projectKey?: string;
  /** An explicit JQL override. Defaults to a project (or instance) query with
   *  NO status filter (all states) ordered by creation. */
  jql?: string;
  /** Issues per page (Jira caps at 100; default 100). */
  pageSize?: number;
  includeComments?: boolean;
  includeAttachments?: boolean;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

interface JiraUser {
  emailAddress?: string | null;
  displayName?: string | null;
}
interface JiraNamed {
  name?: string;
}
interface JiraComment {
  author?: JiraUser | null;
  body?: unknown;
  created?: string | null;
}
interface JiraAttachment {
  filename?: string;
  content?: string;
  mimeType?: string | null;
  size?: number | null;
}
interface JiraLink {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: { key?: string };
  outwardIssue?: { key?: string };
}
interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    description?: unknown;
    issuetype?: JiraNamed | null;
    status?: JiraNamed | null;
    priority?: JiraNamed | null;
    assignee?: JiraUser | null;
    reporter?: JiraUser | null;
    labels?: string[];
    parent?: { key?: string } | null;
    issuelinks?: JiraLink[];
    created?: string | null;
    resolutiondate?: string | null;
    comment?: { comments?: JiraComment[] } | null;
    attachment?: JiraAttachment[] | null;
  };
}
interface JiraSearchResponse {
  issues?: JiraIssue[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

const DEFAULT_PAGE_SIZE = 100;
const SEARCH_FIELDS = [
  'summary',
  'description',
  'issuetype',
  'status',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'parent',
  'issuelinks',
  'created',
  'resolutiondate',
  'comment',
  'attachment',
].join(',');

/** Flatten an Atlassian Document Format (ADF) node — or a plain string — to
 *  best-effort plain text, inserting newlines at block boundaries. */
export function adfToText(doc: unknown): string | null {
  if (doc == null) return null;
  if (typeof doc === 'string') return doc.trim() === '' ? null : doc;
  const parts: string[] = [];
  const BLOCK = new Set(['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'rule']);
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
    if (n.type === 'hardBreak') parts.push('\n');
    if (Array.isArray(n.content)) {
      n.content.forEach(walk);
      if (n.type && BLOCK.has(n.type)) parts.push('\n');
    }
  };
  walk(doc);
  const text = parts
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text === '' ? null : text;
}

export class JiraConnector implements IssueSourceConnector {
  readonly source = 'jira' as const;
  private readonly config: JiraConnectorConfig;
  private readonly baseUrl: string;
  private readonly pageSize: number;
  private readonly includeComments: boolean;
  private readonly includeAttachments: boolean;

  constructor(config: JiraConnectorConfig) {
    if (!config.baseUrl) throw new ConnectorConfigError('a Jira base URL is required', 'jira');
    if (!config.apiToken) throw new ConnectorConfigError('a Jira API token is required', 'jira');
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.pageSize = Math.min(100, config.pageSize ?? DEFAULT_PAGE_SIZE);
    this.includeComments = config.includeComments ?? true;
    this.includeAttachments = config.includeAttachments ?? true;
  }

  private authHeader(): string {
    if (this.config.email) {
      const basic = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString('base64');
      return `Basic ${basic}`;
    }
    return `Bearer ${this.config.apiToken}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: this.authHeader(), Accept: 'application/json' };
  }

  private retryOpts(): RetryOptions {
    return {
      ...this.config.retry,
      source: 'jira',
      fetchImpl: this.config.fetchImpl ?? this.config.retry?.fetchImpl,
    };
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: 'GET', headers: this.headers() },
      this.retryOpts(),
    );
    return (await res.json()) as T;
  }

  private jql(): string {
    if (this.config.jql) return this.config.jql;
    // NO status/resolution clause → every state (whole-history scope).
    const prefix = this.config.projectKey ? `project = "${this.config.projectKey}" ` : '';
    return `${prefix}ORDER BY created ASC`;
  }

  private sourceRef(): string {
    if (this.config.projectKey) return this.config.projectKey;
    try {
      return new URL(this.baseUrl).host;
    } catch {
      return this.baseUrl;
    }
  }

  async connect(): Promise<ConnectResult> {
    // Validate credentials.
    await this.getJson('/rest/api/3/myself');
    // A zero-row search returns the total cheaply.
    const jql = encodeURIComponent(this.jql());
    const probe = await this.getJson<JiraSearchResponse>(
      `/rest/api/3/search?jql=${jql}&maxResults=0`,
    );
    return { source: 'jira', sourceRef: this.sourceRef(), issueCount: probe.total ?? null };
  }

  async discoverFields(): Promise<SourceFieldVocabulary> {
    const [types, statuses, priorities, labels] = await Promise.all([
      this.getJson<JiraNamed[]>('/rest/api/3/issuetype').then((r) => names(r)),
      this.getJson<JiraNamed[]>('/rest/api/3/status').then((r) => names(r)),
      this.getJson<JiraNamed[]>('/rest/api/3/priority').then((r) => names(r)),
      this.getJson<{ values?: string[] }>('/rest/api/3/label?maxResults=1000').then(
        (r) => r.values ?? [],
      ),
    ]);
    return {
      types: unique(types),
      statuses: unique(statuses),
      priorities: unique(priorities),
      labels: unique(labels),
    };
  }

  async listIssues(cursor?: string | null): Promise<SourceIssuePage> {
    const startAt = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const jql = encodeURIComponent(this.jql());
    const res = await this.getJson<JiraSearchResponse>(
      `/rest/api/3/search?jql=${jql}&startAt=${startAt}&maxResults=${this.pageSize}&fields=${SEARCH_FIELDS}`,
    );
    const batch = res.issues ?? [];
    const total = res.total ?? startAt + batch.length;
    const errors: SourceIssueError[] = [];
    const issues: SourceIssue[] = [];

    for (const raw of batch) {
      try {
        issues.push(this.mapIssue(raw));
      } catch (err) {
        errors.push({ externalId: raw.key ?? null, message: `map failed: ${String(err)}` });
      }
    }

    const nextStart = startAt + batch.length;
    return {
      issues,
      errors,
      nextCursor: batch.length > 0 && nextStart < total ? String(nextStart) : null,
    };
  }

  private mapIssue(raw: JiraIssue): SourceIssue {
    const f = raw.fields ?? {};
    const comments: SourceComment[] =
      this.includeComments && f.comment?.comments
        ? f.comment.comments.map((c) => ({
            authorEmail: c.author?.emailAddress ?? null,
            authorName: c.author?.displayName ?? null,
            body: adfToText(c.body) ?? '',
            createdAt: c.created ?? null,
          }))
        : [];
    const attachments: SourceAttachmentRef[] =
      this.includeAttachments && f.attachment
        ? f.attachment.map((a) => ({
            filename: a.filename ?? 'attachment',
            url: a.content ?? '',
            contentType: a.mimeType ?? null,
            byteSize: a.size ?? null,
          }))
        : [];
    const links: SourceLink[] = (f.issuelinks ?? [])
      .map((l): SourceLink | null => {
        const target = l.outwardIssue?.key ?? l.inwardIssue?.key;
        if (!target) return null;
        return { type: l.type?.name ?? 'relates', targetExternalId: target };
      })
      .filter((l): l is SourceLink => l !== null);

    return {
      externalId: raw.key,
      title: f.summary ?? '',
      descriptionMd: adfToText(f.description),
      type: f.issuetype?.name ?? null,
      status: f.status?.name ?? null,
      priority: f.priority?.name ?? null,
      assigneeEmail: f.assignee?.emailAddress ?? null,
      assigneeName: f.assignee?.displayName ?? null,
      reporterEmail: f.reporter?.emailAddress ?? null,
      reporterName: f.reporter?.displayName ?? null,
      labels: f.labels ?? [],
      comments,
      attachments,
      parentExternalId: f.parent?.key ?? null,
      links,
      createdAt: f.created ?? null,
      closedAt: f.resolutiondate ?? null,
    };
  }
}

function names(rows: JiraNamed[]): string[] {
  return rows.map((r) => r.name).filter((n): n is string => Boolean(n));
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
