import { describe, expect, it } from 'vitest';
import { toDispatchRunContinuesDto } from '@/lib/mappers/dispatchRunMappers';

// `toDispatchRunContinuesDto` reads a `continue` run's `run_opened` event data
// (MOTIR-6795). That JSON is written by the continue claim, but an older claim
// wrote no such shape, so every field is read defensively: an unreadable value
// reads as ABSENT and the mapper never throws. These tests pin both halves.

describe('toDispatchRunContinuesDto', () => {
  it('maps a well-formed continue scope, primary branch first', () => {
    expect(
      toDispatchRunContinuesDto({
        continuesRunId: 'run_dead',
        branch: 'motir/acme-7',
        branches: [
          { repository: 'acme/web', branch: 'motir/acme-7' },
          { repository: 'acme/api', branch: 'motir/acme-7-api' },
        ],
        mode: 'parent',
        landedKeys: ['ACME-8'],
        resumedKeys: ['ACME-9', 'ACME-10'],
      }),
    ).toEqual({
      fromRunId: 'run_dead',
      branch: 'motir/acme-7',
      branches: [
        { repository: 'acme/web', branch: 'motir/acme-7', cloneUrl: null },
        { repository: 'acme/api', branch: 'motir/acme-7-api', cloneUrl: null },
      ],
      mode: 'parent',
      landedKeys: ['ACME-8'],
      resumedKeys: ['ACME-9', 'ACME-10'],
    });
  });

  it.each([null, undefined, {}])('reads %s as an empty card-mode scope', (data) => {
    expect(toDispatchRunContinuesDto(data)).toEqual({
      fromRunId: null,
      branch: null,
      branches: [],
      mode: 'card',
      landedKeys: [],
      resumedKeys: [],
    });
  });

  it('reads unreadable fields as absent rather than throwing', () => {
    expect(
      toDispatchRunContinuesDto({
        continuesRunId: 42,
        branch: '',
        branches: 'not-an-array',
        mode: 'something-else',
        landedKeys: 'ACME-1',
        resumedKeys: ['ACME-2', 3, null],
      }),
    ).toEqual({
      fromRunId: null,
      branch: null,
      branches: [],
      mode: 'card',
      landedKeys: [],
      resumedKeys: ['ACME-2'],
    });
  });

  it('drops a branch entry with no readable branch, and keeps one with no repository', () => {
    expect(
      toDispatchRunContinuesDto({
        branches: [
          null,
          { repository: 'acme/web' },
          { repository: 'acme/api', branch: '' },
          { repository: 7, branch: 'motir/acme-7' },
        ],
      }).branches,
    ).toEqual([{ repository: null, branch: 'motir/acme-7', cloneUrl: null }]);
  });
});
