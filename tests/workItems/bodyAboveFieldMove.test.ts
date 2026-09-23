import { describe, expect, it } from 'vitest';
import {
  bodyEditAboveFieldMove,
  describeBodyAboveFieldMove,
  type RevisionKeys,
} from '@/lib/workItems/bodyAboveFieldMove';

// THE BODY-EDIT-ABOVE-FIELD-MOVE predicate (MOTIR-5399) — pure, no database.
// The integration half (the batched trail read, every surface it reaches) is
// `tests/dispatch/bodyAboveFieldMoveAdvisory.test.ts`.

const at = (iso: string) => new Date(iso);
const row = (iso: string, keys: string[], changeKind = 'updated'): RevisionKeys => ({
  changeKind,
  changedAt: at(iso),
  keys,
});

/**
 * MOTIR-4513's trail, FROZEN — the keys `get_work_item_activity` returned for its
 * 20 newest revisions on 2026-09-23, newest first. Frozen rather than read live
 * because the live trail is the one the check must go QUIET on (see below).
 */
const MOTIR_4513_TRAIL: RevisionKeys[] = [
  row('2026-09-05T00:24:32.965Z', ['status']),
  row('2026-09-04T22:33:29.563Z', ['status']),
  row('2026-09-04T22:33:26.547Z', ['status']),
  row('2026-09-04T22:28:04.501Z', ['status']),
  row('2026-09-04T22:27:27.055Z', ['descriptionMd', 'explanationMd']),
  row('2026-09-04T22:17:15.184Z', ['status']),
  row('2026-09-04T22:17:11.662Z', ['links']),
  row('2026-09-04T21:53:11.847Z', ['descriptionMd', 'explanationMd']),
  row('2026-09-04T21:25:39.285Z', ['links']),
  row('2026-09-04T21:25:39.223Z', ['links']),
  row('2026-09-04T21:25:39.179Z', ['links']),
  row('2026-09-04T21:25:39.100Z', [
    'type',
    'title',
    'executor',
    'targetRepo',
    'targetRepos',
    'descriptionMd',
    'explanationMd',
    'estimateMinutes',
  ]),
  row('2026-09-04T14:59:06.932Z', ['links']),
  row('2026-09-04T14:58:19.489Z', ['descriptionMd', 'explanationMd']),
];

/** The trail as it stood at `iso` — every row written at or before it. */
const asOf = (trail: RevisionKeys[], iso: string) => trail.filter((r) => r.changedAt <= at(iso));

describe('bodyEditAboveFieldMove — the MOTIR-4513 specimen', () => {
  it('FIRES on the trail as it stood at the 21:53 revert, naming both writes and their fields', () => {
    expect(bodyEditAboveFieldMove(asOf(MOTIR_4513_TRAIL, '2026-09-04T21:53:11.847Z'))).toEqual({
      bodyEdit: {
        at: at('2026-09-04T21:53:11.847Z'),
        fields: ['descriptionMd', 'explanationMd'],
      },
      fieldMove: {
        at: at('2026-09-04T21:25:39.100Z'),
        fields: ['title', 'type', 'executor', 'targetRepo', 'targetRepos', 'estimateMinutes'],
      },
    });
  });

  it('STILL fires after the run picked it up — a status row moves neither half', () => {
    // 22:17 is the dispatched run picking the card up: the moment the finding was needed.
    const found = bodyEditAboveFieldMove(asOf(MOTIR_4513_TRAIL, '2026-09-04T22:17:15.184Z'));
    expect(found?.bodyEdit.at).toEqual(at('2026-09-04T21:53:11.847Z'));
  });

  it('goes QUIET after the 22:27 corrective body pass — the edit no longer sits on the move', () => {
    expect(bodyEditAboveFieldMove(MOTIR_4513_TRAIL)).toBeNull();
  });
});

describe('bodyEditAboveFieldMove — the shape of the rule', () => {
  it('says nothing when the NEWEST relevant write moved a field — the fields have the last word', () => {
    expect(
      bodyEditAboveFieldMove([
        row('2026-01-02T00:00:00Z', ['type', 'descriptionMd']),
        row('2026-01-01T00:00:00Z', ['descriptionMd']),
      ]),
    ).toBeNull();
  });

  it('⚠️ a CREATED row beneath never counts — finishing a new card is not contradicting it', () => {
    // create_work_item takes no explanationMd, so nearly every planned card has
    // exactly this trail: the create, then a body-only follow-up.
    expect(
      bodyEditAboveFieldMove([
        row('2026-01-01T00:01:00Z', ['explanationMd']),
        row('2026-01-01T00:00:00Z', ['title', 'kind', 'type', 'descriptionMd'], 'created'),
      ]),
    ).toBeNull();
  });

  it('a second body edit between them silences it — the edit must sit DIRECTLY above the move', () => {
    expect(
      bodyEditAboveFieldMove([
        row('2026-01-03T00:00:00Z', ['explanationMd']),
        row('2026-01-02T00:00:00Z', ['descriptionMd']),
        row('2026-01-01T00:00:00Z', ['storyPoints']),
      ]),
    ).toBeNull();
  });

  it('skips EVERY row that moves neither half — links, status, assignee, sprint, priority, labels', () => {
    const found = bodyEditAboveFieldMove([
      row('2026-01-09T00:00:00Z', ['links']),
      row('2026-01-08T00:00:00Z', ['status', 'assigneeId']),
      row('2026-01-07T00:00:00Z', ['descriptionMd']),
      row('2026-01-06T00:00:00Z', ['sprintId']),
      row('2026-01-05T00:00:00Z', ['priority']),
      row('2026-01-04T00:00:00Z', ['labels']),
      row('2026-01-03T00:00:00Z', ['comment'], 'comment_deleted'),
      row('2026-01-02T00:00:00Z', ['kind']),
    ]);
    expect(found).toEqual({
      bodyEdit: { at: at('2026-01-07T00:00:00Z'), fields: ['descriptionMd'] },
      fieldMove: { at: at('2026-01-02T00:00:00Z'), fields: ['kind'] },
    });
  });

  it('fires for EACH watched field on its own, and never for a bookkeeping one', () => {
    for (const field of [
      'title',
      'type',
      'executor',
      'targetRepo',
      'targetRepos',
      'kind',
      'storyPoints',
      'estimateMinutes',
    ]) {
      expect(
        bodyEditAboveFieldMove([
          row('2026-01-02T00:00:00Z', ['descriptionMd']),
          row('2026-01-01T00:00:00Z', [field]),
        ])?.fieldMove.fields,
      ).toEqual([field]);
    }
    // A priority move beneath is skipped, and there is nothing further down.
    expect(
      bodyEditAboveFieldMove([
        row('2026-01-02T00:00:00Z', ['descriptionMd']),
        row('2026-01-01T00:00:00Z', ['priority']),
      ]),
    ).toBeNull();
  });

  it('names ONLY the fields the check reads, in a stable order whatever order the row stored', () => {
    // jsonb stores keys shortest-first; the reader sees the canonical order.
    const found = bodyEditAboveFieldMove([
      row('2026-01-02T00:00:00Z', ['explanationMd', 'priority', 'descriptionMd']),
      row('2026-01-01T00:00:00Z', ['kind', 'title', 'status', 'storyPoints']),
    ]);
    expect(found?.bodyEdit.fields).toEqual(['descriptionMd', 'explanationMd']);
    expect(found?.fieldMove.fields).toEqual(['title', 'kind', 'storyPoints']);
  });

  it('says nothing for an empty trail, a lone write, or a trail of bookkeeping only', () => {
    expect(bodyEditAboveFieldMove([])).toBeNull();
    expect(bodyEditAboveFieldMove([row('2026-01-01T00:00:00Z', ['descriptionMd'])])).toBeNull();
    expect(
      bodyEditAboveFieldMove([
        row('2026-01-02T00:00:00Z', ['status']),
        row('2026-01-01T00:00:00Z', ['links']),
      ]),
    ).toBeNull();
  });
});

describe('describeBodyAboveFieldMove — the sentence every renderer shares', () => {
  it('names the card, both instants and both field lists', () => {
    expect(
      describeBodyAboveFieldMove({
        item: 'MOTIR-4513',
        bodyEdit: { at: '2026-09-04T21:53:11.847Z', fields: ['descriptionMd', 'explanationMd'] },
        fieldMove: { at: '2026-09-04T21:25:39.100Z', fields: ['title', 'type'] },
      }),
    ).toBe(
      "MOTIR-4513's descriptionMd + explanationMd was edited at 2026-09-04T21:53:11.847Z by a " +
        'write that moved none of its fields, directly above the write at ' +
        '2026-09-04T21:25:39.100Z that moved title, type',
    );
  });
});
