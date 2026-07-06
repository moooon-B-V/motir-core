// The CSV connector (Story 7.16 · MOTIR-1501) — the universal, CREDENTIAL-FREE
// source (ADR §1). Any tracker's file export (Jira / Linear / Plane CSV) or a
// hand-made sheet rides this one connector: one row → one `SourceIssue`, the id
// column as `externalId`. Column → field wiring is auto-detected from common
// header names and overridable per-import (`columnMap`); a missing column is
// "unmapped", never an error (the resolver treats it as empty). Per-row problems
// (empty id, empty title, a ragged row) are collected as `SourceIssueError`s —
// never a whole-file abort.
//
// No DB, no Prisma — a file parse only.

import { parseCsvRows, type CsvRecord } from '../csv/parseCsv';
import { ConnectorConfigError } from './errors';
import type {
  ConnectResult,
  IssueSourceConnector,
  SourceFieldVocabulary,
  SourceIssue,
  SourceIssueError,
  SourceIssuePage,
} from './types';

/** Which header column feeds which `SourceIssue` field. Every entry optional —
 *  an absent field is simply unmapped. */
export interface CsvColumnMap {
  externalId?: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  priority?: string;
  assigneeEmail?: string;
  assigneeName?: string;
  reporterEmail?: string;
  reporterName?: string;
  /** One column holding `;`- or `,`-separated label names. */
  labels?: string;
  parentExternalId?: string;
  createdAt?: string;
  closedAt?: string;
}

export interface CsvConnectorConfig {
  filename: string;
  /** The uploaded file's text. (A future large-file path streams chunks via
   *  `parseCsvRecordsFromStream`; the foundational slice takes the string.) */
  content: string;
  /** Explicit overrides for auto-detection (per-column). */
  columnMap?: CsvColumnMap;
  delimiter?: string;
  /** Rows per `listIssues` page (default 500). */
  pageSize?: number;
}

/** Case-insensitive header-name candidates per field, best-match wins. */
const AUTO_CANDIDATES: Record<keyof CsvColumnMap, string[]> = {
  externalId: ['id', 'issue id', 'issue key', 'key', 'external id', 'issue-id', 'number'],
  title: ['title', 'summary', 'name'],
  description: ['description', 'body', 'desc', 'details'],
  type: ['type', 'issue type', 'issuetype', 'work type', 'kind'],
  status: ['status', 'state', 'workflow status'],
  priority: ['priority'],
  assigneeEmail: ['assignee email', 'assignee', 'assigned to', 'assignee_email'],
  assigneeName: ['assignee name', 'assignee display name'],
  reporterEmail: ['reporter email', 'reporter', 'created by', 'author', 'creator'],
  reporterName: ['reporter name', 'creator name'],
  labels: ['labels', 'label', 'tags', 'tag', 'components'],
  parentExternalId: ['parent', 'parent id', 'parent key', 'epic link', 'epic'],
  createdAt: ['created', 'created at', 'created date', 'created_at', 'date created'],
  closedAt: ['closed', 'closed at', 'resolved', 'resolution date', 'done date', 'completed'],
};

const DEFAULT_PAGE_SIZE = 500;

export class CsvConnector implements IssueSourceConnector {
  readonly source = 'csv' as const;
  private readonly config: CsvConnectorConfig;
  private readonly pageSize: number;
  /** Memoised parse of the (already in-memory) file — parsed once, paged O(1). */
  private parsed: { header: string[]; records: CsvRecord[]; resolved: CsvColumnMap } | null = null;

  constructor(config: CsvConnectorConfig) {
    this.config = config;
    this.pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
  }

  private ensureParsed(): { header: string[]; records: CsvRecord[]; resolved: CsvColumnMap } {
    if (this.parsed) return this.parsed;
    const text = this.config.content;
    if (text.trim() === '') {
      throw new ConnectorConfigError('the uploaded CSV is empty', 'csv');
    }
    // ONE parse of the (already in-memory) file: first raw row = header, the
    // rest become records.
    const iter = parseCsvRows(text, this.config.delimiter)[Symbol.iterator]();
    const first = iter.next();
    if (first.done) {
      throw new ConnectorConfigError('the CSV has no header row', 'csv');
    }
    const header = first.value.map((h) => h.trim());
    const records: CsvRecord[] = [];
    let line = 0;
    for (let r = iter.next(); !r.done; r = iter.next()) {
      line++;
      const values: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) {
        values[header[i] || `col${i}`] = r.value[i] ?? '';
      }
      records.push({ values, line, columnCount: r.value.length });
    }
    const resolved = this.resolveColumns(header);
    this.parsed = { header, records, resolved };
    return this.parsed;
  }

  /** Map each `SourceIssue` field to an actual header (explicit override wins,
   *  else the first auto-candidate that appears, case-insensitively). */
  private resolveColumns(header: string[]): CsvColumnMap {
    const lower = new Map(header.map((h) => [h.trim().toLowerCase(), h.trim()]));
    const explicit = this.config.columnMap ?? {};
    const resolved: CsvColumnMap = {};
    for (const field of Object.keys(AUTO_CANDIDATES) as (keyof CsvColumnMap)[]) {
      const override = explicit[field];
      if (override && lower.has(override.trim().toLowerCase())) {
        resolved[field] = lower.get(override.trim().toLowerCase());
        continue;
      }
      for (const candidate of AUTO_CANDIDATES[field]) {
        const hit = lower.get(candidate);
        if (hit) {
          resolved[field] = hit;
          break;
        }
      }
    }
    return resolved;
  }

  async connect(): Promise<ConnectResult> {
    const { records } = this.ensureParsed();
    return { source: 'csv', sourceRef: this.config.filename, issueCount: records.length };
  }

  async discoverFields(): Promise<SourceFieldVocabulary> {
    const { records, resolved } = this.ensureParsed();
    const types = new Set<string>();
    const statuses = new Set<string>();
    const priorities = new Set<string>();
    const labels = new Set<string>();
    for (const rec of records) {
      if (resolved.type) addIfPresent(types, rec.values[resolved.type]);
      if (resolved.status) addIfPresent(statuses, rec.values[resolved.status]);
      if (resolved.priority) addIfPresent(priorities, rec.values[resolved.priority]);
      if (resolved.labels) splitLabels(rec.values[resolved.labels]).forEach((l) => labels.add(l));
    }
    return {
      types: [...types].sort(),
      statuses: [...statuses].sort(),
      priorities: [...priorities].sort(),
      labels: [...labels].sort(),
    };
  }

  async listIssues(cursor?: string | null): Promise<SourceIssuePage> {
    const { header, records, resolved } = this.ensureParsed();
    const offset = cursor ? Math.max(0, Number.parseInt(cursor, 10) || 0) : 0;
    const slice = records.slice(offset, offset + this.pageSize);
    const errors: SourceIssueError[] = [];
    const issues: SourceIssue[] = [];

    for (const rec of slice) {
      issues.push(this.mapRecord(rec, header.length, resolved, errors));
    }

    const next = offset + this.pageSize;
    return { issues, errors, nextCursor: next < records.length ? String(next) : null };
  }

  private mapRecord(
    rec: CsvRecord,
    headerLen: number,
    resolved: CsvColumnMap,
    errors: SourceIssueError[],
  ): SourceIssue {
    const get = (field: keyof CsvColumnMap): string | null => {
      const col = resolved[field];
      if (!col) return null;
      const v = rec.values[col];
      return v != null && v.trim() !== '' ? v.trim() : null;
    };

    let externalId = get('externalId');
    if (!externalId) {
      externalId = `csv:row-${rec.line}`;
      if (resolved.externalId) {
        errors.push({
          externalId,
          message: `row ${rec.line}: empty '${resolved.externalId}' — using row position as id (breaks idempotency if rows reorder)`,
        });
      }
    }

    let title = get('title');
    if (!title) {
      errors.push({ externalId, message: `row ${rec.line}: no title — using a placeholder` });
      title = `(untitled ${externalId})`;
    }

    if (rec.columnCount !== headerLen) {
      errors.push({
        externalId,
        message: `row ${rec.line}: ${rec.columnCount} columns, header has ${headerLen} — extra/missing cells ignored`,
      });
    }

    const labels = resolved.labels ? splitLabels(rec.values[resolved.labels]) : [];

    return {
      externalId,
      title,
      descriptionMd: get('description'),
      type: get('type'),
      status: get('status'),
      priority: get('priority'),
      assigneeEmail: get('assigneeEmail'),
      assigneeName: get('assigneeName'),
      reporterEmail: get('reporterEmail'),
      reporterName: get('reporterName'),
      labels,
      comments: [],
      attachments: [],
      parentExternalId: get('parentExternalId'),
      links: [],
      createdAt: normaliseDate(get('createdAt')),
      closedAt: normaliseDate(get('closedAt')),
    };
  }
}

function addIfPresent(set: Set<string>, value: string | undefined): void {
  const v = value?.trim();
  if (v) set.add(v);
}

function splitLabels(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Best-effort ISO normalisation of a source date cell — passes through an
 *  already-parseable date, else returns the raw string (the resolver may still
 *  use it), null when empty. */
function normaliseDate(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
}
