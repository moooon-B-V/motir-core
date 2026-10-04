import { describe, expect, it } from 'vitest';
import {
  auditLogHref,
  hasFilters,
  parseAuditLogQuery,
  shortHash,
  toSearchFilters,
} from '@/app/(admin)/admin/audit-log/_components/auditLogUrl';

/** The audit log's URL state (MOTIR-752, design Panel 6). */
describe('audit log URL state', () => {
  it('the bare route is the default view: writes, newest page, no filter', () => {
    const q = parseAuditLogQuery({});
    expect(q).toEqual({
      q: '',
      actor: '',
      org: '',
      action: '',
      from: '',
      to: '',
      scope: 'writes',
      cursors: [],
      entry: null,
    });
    expect(auditLogHref(q)).toBe('/admin/audit-log');
    expect(hasFilters(q)).toBe(false);
    expect(toSearchFilters(q)).toEqual({
      text: null,
      actorUserId: null,
      organizationId: null,
      action: null,
      dateFrom: null,
      dateTo: null,
      writesOnly: true,
    });
  });

  it('round-trips every filter, the cursor stack and the open entry', () => {
    const href =
      '/admin/audit-log?q=ticket&actor=u1&org=o1&action=org.suspend&from=2026-09-01&to=2026-09-30&scope=all&c=900%2C850&entry=849';
    const q = parseAuditLogQuery(Object.fromEntries(new URL(`http://x${href}`).searchParams));
    expect(q.cursors).toEqual(['900', '850']);
    expect(q.entry).toBe(849);
    expect(auditLogHref(q)).toBe(href);
    expect(hasFilters(q)).toBe(true);
  });

  it('makes the inclusive "Through" day exclusive for the service, and reads "Writes & reads"', () => {
    const f = toSearchFilters(parseAuditLogQuery({ to: '2026-09-30', scope: 'all' }));
    expect(f.dateTo).toBe('2026-10-01');
    expect(f.writesOnly).toBe(false);
  });

  it('drops what a person could have typed wrong: bad dates, bad cursors, bad entries', () => {
    const q = parseAuditLogQuery({
      from: 'yesterday',
      c: '12,abc,0,-1',
      entry: 'x',
      scope: 'nope',
    });
    expect(q.from).toBe('');
    expect(q.cursors).toEqual(['12']);
    expect(q.entry).toBeNull();
    expect(q.scope).toBe('writes');
  });

  it('abbreviates a hash the way the design draws it', () => {
    expect(shortHash('9f3c00000000000000000000a41e')).toBe('9f3c…a41e');
    expect(shortHash('abc')).toBe('abc');
  });
});
