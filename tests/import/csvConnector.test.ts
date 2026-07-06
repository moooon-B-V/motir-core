import { describe, expect, it } from 'vitest';
import { CsvConnector } from '@/lib/import/connectors/csvConnector';
import { ConnectorConfigError } from '@/lib/import/connectors/errors';

// Unit tests for the CSV connector (MOTIR-1501): auto column detection,
// SourceIssue mapping, label split, per-row errors, paging, discoverFields.

const HEADER = 'Issue key,Summary,Type,Status,Priority,Assignee,Labels,Parent,Created';
function csv(...rows: string[]): string {
  return [HEADER, ...rows].join('\n');
}

describe('CsvConnector.connect', () => {
  it('reports the filename ref and the data-row count', async () => {
    const c = new CsvConnector({
      filename: 'export.csv',
      content: csv('PROJ-1,First,Bug,Open,High,a@x.com,"bug;ui",,2026-01-01'),
    });
    const r = await c.connect();
    expect(r).toEqual({ source: 'csv', sourceRef: 'export.csv', issueCount: 1 });
  });

  it('throws ConnectorConfigError on an empty file', async () => {
    const c = new CsvConnector({ filename: 'empty.csv', content: '   ' });
    await expect(c.connect()).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});

describe('CsvConnector.listIssues — mapping', () => {
  it('auto-detects columns and normalises a row', async () => {
    const c = new CsvConnector({
      filename: 'x.csv',
      content: csv(
        'PROJ-1,Login bug,Bug,In Progress,High,dev@x.com,"backend, urgent",PROJ-9,2026-01-02T10:00:00Z',
      ),
    });
    const page = await c.listIssues();
    expect(page.errors).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.issues[0]).toMatchObject({
      externalId: 'PROJ-1',
      title: 'Login bug',
      type: 'Bug',
      status: 'In Progress',
      priority: 'High',
      assigneeEmail: 'dev@x.com',
      labels: ['backend', 'urgent'],
      parentExternalId: 'PROJ-9',
    });
    expect(page.issues[0]!.createdAt).toBe('2026-01-02T10:00:00.000Z');
  });

  it('records a per-row error and synthesises an id when the id cell is empty', async () => {
    const c = new CsvConnector({ filename: 'x.csv', content: csv(',No id row,Bug,Open,Low,,,,') });
    const page = await c.listIssues();
    expect(page.issues[0]!.externalId).toBe('csv:row-1');
    expect(page.errors.some((e) => /empty 'Issue key'/.test(e.message))).toBe(true);
  });

  it('flags an empty title with a placeholder', async () => {
    const c = new CsvConnector({ filename: 'x.csv', content: csv('PROJ-2,,Bug,Open,Low,,,,') });
    const page = await c.listIssues();
    expect(page.issues[0]!.title).toBe('(untitled PROJ-2)');
    expect(page.errors.some((e) => /no title/.test(e.message))).toBe(true);
  });

  it('flags a ragged row but still maps what it can', async () => {
    // Only 3 columns vs 9 in the header.
    const c = new CsvConnector({ filename: 'x.csv', content: csv('PROJ-3,Short,Bug') });
    const page = await c.listIssues();
    expect(page.issues[0]!.externalId).toBe('PROJ-3');
    expect(page.issues[0]!.type).toBe('Bug');
    expect(page.errors.some((e) => /columns, header has 9/.test(e.message))).toBe(true);
  });

  it('leaves unmapped fields null (no id column at all → synth ids, no error)', async () => {
    const c = new CsvConnector({ filename: 'x.csv', content: 'name,notes\nAlpha,hi\nBeta,yo' });
    const page = await c.listIssues();
    expect(page.issues.map((i) => i.externalId)).toEqual(['csv:row-1', 'csv:row-2']);
    // 'name' matches the title candidate; nothing else maps.
    expect(page.issues[0]!.title).toBe('Alpha');
    expect(page.issues[0]!.status).toBeNull();
    expect(page.errors).toEqual([]);
  });

  it('honours an explicit columnMap override', async () => {
    const c = new CsvConnector({
      filename: 'x.csv',
      content: 'ticket,headline\nT-1,Hello',
      columnMap: { externalId: 'ticket', title: 'headline' },
    });
    const page = await c.listIssues();
    expect(page.issues[0]).toMatchObject({ externalId: 'T-1', title: 'Hello' });
  });
});

describe('CsvConnector.listIssues — paging', () => {
  it('pages by cursor and terminates', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => `PROJ-${i},Row ${i},Bug,Open,Low,,,,`);
    const c = new CsvConnector({ filename: 'x.csv', content: csv(...rows), pageSize: 2 });
    const p1 = await c.listIssues();
    expect(p1.issues.map((i) => i.externalId)).toEqual(['PROJ-0', 'PROJ-1']);
    expect(p1.nextCursor).toBe('2');
    const p2 = await c.listIssues(p1.nextCursor);
    expect(p2.issues.map((i) => i.externalId)).toEqual(['PROJ-2', 'PROJ-3']);
    expect(p2.nextCursor).toBe('4');
    const p3 = await c.listIssues(p2.nextCursor);
    expect(p3.issues.map((i) => i.externalId)).toEqual(['PROJ-4']);
    expect(p3.nextCursor).toBeNull();
  });
});

describe('CsvConnector.discoverFields', () => {
  it('collects distinct types/statuses/priorities/labels', async () => {
    const c = new CsvConnector({
      filename: 'x.csv',
      content: csv(
        'P-1,A,Bug,Open,High,,"ui;api",,',
        'P-2,B,Story,Done,Low,,"api;db",,',
        'P-3,C,Bug,Open,High,,ui,,',
      ),
    });
    const v = await c.discoverFields();
    expect(v.types).toEqual(['Bug', 'Story']);
    expect(v.statuses).toEqual(['Done', 'Open']);
    expect(v.priorities).toEqual(['High', 'Low']);
    expect(v.labels).toEqual(['api', 'db', 'ui']);
  });
});
