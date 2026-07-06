// The Plane connector (Story 7.16 · MOTIR-1639) — Plane (plane.so, open-source,
// self-hostable PM tool) as a fifth import source on the SAME
// `IssueSourceConnector` seam + `./http` paginate/retry scaffolding (MOTIR-1501)
// — a new connector, not a pipeline change (the extension-seam decision, ADR §1).
//
// Live REST, cursor-paginated (`per_page` + `cursor`, loop while
// `next_page_results`). Auth is an `X-API-Key` PAT (Plane Profile Settings →
// Personal Access Tokens); `baseUrl` is `https://api.plane.so` for Cloud or the
// user's self-hosted instance URL (MOTIR-943 provisions both + the workspace
// slug). Targets `/work-items/` (Plane deprecated the older `/issues/` path).
//
// Whole-history scope (ADR §1): NO state filter — every state GROUP
// (backlog/unstarted/started/completed/cancelled) is fetched; completed/
// cancelled are done-category. `externalId` = the work-item UUID `id` (stable),
// NOT the renameable `{project}-{seq}` display ref.
//
// The list response returns related fields (state/assignees/labels/created_by)
// as ids; the connector requests `expand` so they arrive as objects and maps
// defensively (falls back to the id when an expansion is absent). No DB writes.

import { ConnectorConfigError } from './errors';
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

export interface PlaneConnectorConfig {
  /** The Plane PAT — sent as `X-API-Key` (MOTIR-943). */
  apiKey: string;
  /** `https://api.plane.so` (Cloud, default) or a self-hosted instance URL. */
  baseUrl?: string;
  workspaceSlug: string;
  projectId: string;
  /** Work-items per page (Plane caps at 100; default 100). */
  perPage?: number;
  includeComments?: boolean;
  retry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

interface PlaneMember {
  email?: string | null;
  display_name?: string | null;
}
interface PlaneState {
  name?: string | null;
  group?: string | null;
}
interface PlaneLabel {
  name?: string | null;
}
interface PlaneWorkItem {
  id: string;
  name?: string;
  description_stripped?: string | null;
  priority?: string | null;
  parent?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  // Expanded (or id) forms:
  state?: PlaneState | string | null;
  state_detail?: PlaneState | null;
  assignees?: Array<PlaneMember | string> | null;
  assignee_details?: PlaneMember[] | null;
  labels?: Array<PlaneLabel | string> | null;
  label_details?: PlaneLabel[] | null;
  created_by?: PlaneMember | string | null;
  created_by_detail?: PlaneMember | null;
}
interface PlaneListResponse<T> {
  results?: T[];
  next_cursor?: string | null;
  next_page_results?: boolean;
  total_count?: number;
  count?: number;
}
interface PlaneComment {
  comment_stripped?: string | null;
  comment_html?: string | null;
  created_at?: string | null;
  actor_detail?: PlaneMember | null;
}

const DEFAULT_BASE_URL = 'https://api.plane.so';
const DEFAULT_PER_PAGE = 100;
const EXPAND = 'state,assignees,labels,created_by';

export class PlaneConnector implements IssueSourceConnector {
  readonly source = 'plane' as const;
  private readonly config: PlaneConnectorConfig;
  private readonly baseUrl: string;
  private readonly perPage: number;
  private readonly includeComments: boolean;

  constructor(config: PlaneConnectorConfig) {
    if (!config.apiKey) throw new ConnectorConfigError('a Plane API key is required', 'plane');
    if (!config.workspaceSlug || !config.projectId) {
      throw new ConnectorConfigError('a Plane workspace slug and project id are required', 'plane');
    }
    this.config = config;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.perPage = Math.min(100, config.perPage ?? DEFAULT_PER_PAGE);
    this.includeComments = config.includeComments ?? true;
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.config.apiKey, Accept: 'application/json' };
  }

  private retryOpts(): RetryOptions {
    return {
      ...this.config.retry,
      source: 'plane',
      fetchImpl: this.config.fetchImpl ?? this.config.retry?.fetchImpl,
    };
  }

  private projectPath(): string {
    return `/api/v1/workspaces/${this.config.workspaceSlug}/projects/${this.config.projectId}`;
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetchWithRetry(
      `${this.baseUrl}${path}`,
      { method: 'GET', headers: this.headers() },
      this.retryOpts(),
    );
    return (await res.json()) as T;
  }

  async connect(): Promise<ConnectResult> {
    const probe = await this.getJson<PlaneListResponse<PlaneWorkItem>>(
      `${this.projectPath()}/work-items/?per_page=1`,
    );
    return {
      source: 'plane',
      sourceRef: `${this.config.workspaceSlug}/${this.config.projectId}`,
      issueCount: probe.total_count ?? probe.count ?? null,
    };
  }

  async discoverFields(): Promise<SourceFieldVocabulary> {
    const [states, labels] = await Promise.all([
      this.getJson<PlaneListResponse<PlaneState>>(
        `${this.projectPath()}/states/?per_page=100`,
      ).then((r) => r.results ?? []),
      this.getJson<PlaneListResponse<PlaneLabel>>(
        `${this.projectPath()}/labels/?per_page=100`,
      ).then((r) => r.results ?? []),
    ]);
    return {
      types: [], // no native work-item type in this slice — label/module-derived
      statuses: unique(states.map((s) => s.name).filter(isString)),
      priorities: ['urgent', 'high', 'medium', 'low', 'none'], // Plane's fixed scale
      labels: unique(labels.map((l) => l.name).filter(isString)),
    };
  }

  async listIssues(cursor?: string | null): Promise<SourceIssuePage> {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await this.getJson<PlaneListResponse<PlaneWorkItem>>(
      `${this.projectPath()}/work-items/?per_page=${this.perPage}&expand=${EXPAND}${cursorParam}`,
    );
    const batch = res.results ?? [];
    const errors: SourceIssueError[] = [];
    const issues: SourceIssue[] = [];

    for (const raw of batch) {
      try {
        issues.push(await this.mapItem(raw, errors));
      } catch (err) {
        errors.push({ externalId: raw.id ?? null, message: `map failed: ${String(err)}` });
      }
    }

    const nextCursor = res.next_page_results ? (res.next_cursor ?? null) : null;
    return { issues, errors, nextCursor };
  }

  private async mapItem(raw: PlaneWorkItem, errors: SourceIssueError[]): Promise<SourceIssue> {
    const state = typeof raw.state === 'object' && raw.state ? raw.state : raw.state_detail;
    const assignee = firstMember(raw.assignee_details) ?? firstMember(objectMembers(raw.assignees));
    const reporter =
      memberOrNull(raw.created_by_detail) ?? memberOrNull(objectMember(raw.created_by));
    const labels = labelNames(raw.label_details) ?? labelNames(objectLabels(raw.labels)) ?? [];

    let comments: SourceComment[] = [];
    if (this.includeComments) {
      try {
        comments = await this.fetchComments(raw.id);
      } catch (err) {
        errors.push({ externalId: raw.id, message: `comments unavailable: ${String(err)}` });
      }
    }

    return {
      externalId: raw.id,
      title: raw.name ?? '',
      descriptionMd: raw.description_stripped ?? null,
      type: null, // label/module-derived
      status: state?.name ?? null,
      priority: raw.priority ?? null,
      assigneeEmail: assignee?.email ?? null,
      assigneeName: assignee?.display_name ?? null,
      reporterEmail: reporter?.email ?? null,
      reporterName: reporter?.display_name ?? null,
      labels,
      comments,
      attachments: [], // Plane attachments live on a separate endpoint — not in this slice
      parentExternalId: raw.parent ?? null,
      links: [],
      createdAt: raw.created_at ?? null,
      closedAt: raw.completed_at ?? null,
    };
  }

  private async fetchComments(workItemId: string): Promise<SourceComment[]> {
    const out: SourceComment[] = [];
    let cursor: string | null = null;
    for (;;) {
      const cursorParam: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res: PlaneListResponse<PlaneComment> = await this.getJson<
        PlaneListResponse<PlaneComment>
      >(`${this.projectPath()}/work-items/${workItemId}/comments/?per_page=100${cursorParam}`);
      for (const c of res.results ?? []) {
        out.push({
          authorEmail: c.actor_detail?.email ?? null,
          authorName: c.actor_detail?.display_name ?? null,
          body: c.comment_stripped ?? c.comment_html ?? '',
          createdAt: c.created_at ?? null,
        });
      }
      if (!res.next_page_results || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    return out;
  }
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v !== '';
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function memberOrNull(m: PlaneMember | null | undefined): PlaneMember | null {
  return m && typeof m === 'object' ? m : null;
}

function objectMember(v: PlaneMember | string | null | undefined): PlaneMember | null {
  return v && typeof v === 'object' ? v : null;
}

function objectMembers(v: Array<PlaneMember | string> | null | undefined): PlaneMember[] | null {
  if (!Array.isArray(v)) return null;
  const objs = v.filter((m): m is PlaneMember => typeof m === 'object' && m !== null);
  return objs.length > 0 ? objs : null;
}

function firstMember(members: PlaneMember[] | null | undefined): PlaneMember | null {
  return members && members.length > 0 ? (members[0] ?? null) : null;
}

function objectLabels(v: Array<PlaneLabel | string> | null | undefined): PlaneLabel[] | null {
  if (!Array.isArray(v)) return null;
  const objs = v.filter((l): l is PlaneLabel => typeof l === 'object' && l !== null);
  return objs.length > 0 ? objs : null;
}

function labelNames(labels: PlaneLabel[] | null | undefined): string[] | null {
  if (!labels) return null;
  return labels.map((l) => l.name).filter(isString);
}
