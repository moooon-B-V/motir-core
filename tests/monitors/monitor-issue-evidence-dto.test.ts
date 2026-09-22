import { describe, expect, it } from 'vitest';
import type { MonitorIssue } from '@/generated/prisma/client';
import { toMonitorIssueEvidenceDto } from '@/lib/mappers/monitorIssueLinkMappers';

// The EVIDENCE display state, derived ONCE (Story MOTIR-5975 · Subtask
// MOTIR-5979): `never_read` / `no_exception` / `present`, and `stale` exactly
// when the last check is later than the last successful read. Pure — the row is
// a plain object, the mapper touches no database.

const READ = new Date('2026-09-20T18:05:00.000Z');

function row(overrides: Partial<MonitorIssue> = {}): MonitorIssue {
  return {
    exceptionType: null,
    exceptionMessage: null,
    frames: null,
    tags: null,
    requestMethod: null,
    requestPath: null,
    eventId: null,
    eventAt: null,
    evidenceReadAt: null,
    evidenceCheckedAt: null,
    ...overrides,
  } as MonitorIssue;
}

describe('toMonitorIssueEvidenceDto', () => {
  it('never_read — no evidence_read_at, whatever else the row holds', () => {
    expect(toMonitorIssueEvidenceDto(row())).toEqual({
      state: 'never_read',
      stale: false,
      exception: null,
      frames: [],
      tags: [],
      request: null,
      eventId: null,
      eventAt: null,
      readAt: null,
      lastFailedAt: null,
    });
    // Only failed checks and no read: still never_read, and NOT stale — there is
    // nothing old to be stale about.
    expect(toMonitorIssueEvidenceDto(row({ evidenceCheckedAt: READ }))).toMatchObject({
      state: 'never_read',
      stale: false,
      lastFailedAt: null,
    });
  });

  it('no_exception — read, with no exception type or message and no frames', () => {
    const dto = toMonitorIssueEvidenceDto(
      row({
        frames: [],
        tags: [{ key: 'route', value: '/x' }],
        requestMethod: 'GET',
        requestPath: '/x',
        evidenceReadAt: READ,
        evidenceCheckedAt: READ,
      }),
    );
    expect(dto).toMatchObject({
      state: 'no_exception',
      stale: false,
      exception: null,
      tags: [{ key: 'route', value: '/x' }],
      request: { method: 'GET', path: '/x' },
    });
  });

  it('present — an exception, or frames alone', () => {
    expect(
      toMonitorIssueEvidenceDto(
        row({ exceptionMessage: 'boom', evidenceReadAt: READ, evidenceCheckedAt: READ }),
      ),
    ).toMatchObject({ state: 'present', exception: { type: null, message: 'boom' } });
    expect(
      toMonitorIssueEvidenceDto(
        row({
          frames: [{ filePath: 'a.ts', function: 'f', lineNumber: 3, inApp: true }],
          evidenceReadAt: READ,
          evidenceCheckedAt: READ,
        }),
      ),
    ).toMatchObject({
      state: 'present',
      exception: null,
      frames: [{ filePath: 'a.ts', function: 'f', lineNumber: 3, inApp: true }],
    });
  });

  it('stale exactly when evidence_checked_at is later than evidence_read_at', () => {
    const later = new Date(READ.getTime() + 60_000);
    const stale = toMonitorIssueEvidenceDto(
      row({ exceptionType: 'Error', evidenceReadAt: READ, evidenceCheckedAt: later }),
    );
    expect(stale).toMatchObject({
      state: 'present',
      stale: true,
      readAt: READ.toISOString(),
      lastFailedAt: later.toISOString(),
    });
    expect(
      toMonitorIssueEvidenceDto(
        row({ exceptionType: 'Error', evidenceReadAt: READ, evidenceCheckedAt: READ }),
      ),
    ).toMatchObject({ stale: false, lastFailedAt: null });
  });

  it('re-validates the JSON columns — malformed entries are dropped, never trusted', () => {
    const dto = toMonitorIssueEvidenceDto(
      row({
        frames: [
          { filePath: 'ok.ts', lineNumber: 'x', inApp: 'yes' },
          { function: 'no file' },
          null,
        ],
        tags: [{ key: 'k', value: 'v' }, { key: 1, value: 'v' }, 'x'],
        evidenceReadAt: READ,
      }),
    );
    expect(dto.frames).toEqual([
      { filePath: 'ok.ts', function: null, lineNumber: null, inApp: null },
    ]);
    expect(dto.tags).toEqual([{ key: 'k', value: 'v' }]);
    expect(
      toMonitorIssueEvidenceDto(row({ frames: {}, tags: 'no', evidenceReadAt: READ })),
    ).toMatchObject({ frames: [], tags: [] });
  });
});
