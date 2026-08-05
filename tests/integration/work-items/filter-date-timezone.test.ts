import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { compileFilterConditionsSql } from '@/lib/repositories/workItemRepository';
import { customFieldFilterFieldId, type FilterAst } from '@/lib/filters/ast';
import type { ProjectFilterReferents } from '@/lib/filters/registry';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// The date operators under a PINNED Postgres session timezone (MOTIR-2056).
//
// The relative windows (`in_last_days` / `in_next_days`) used to measure from
// `CURRENT_DATE`, which Postgres evaluates in the SESSION timezone, while the
// values they compare against are UTC — `w."createdAt"`/`"dueDate"` are naive
// `timestamp(3)` UTC instants (so `col::date` is the UTC calendar date) and
// `custom_field_value.value_date` is a `date` written from the date-only-ISO
// /UTC convention. On a non-UTC session the two sides were different
// calendars and the window was off by one day, so a row created a second ago
// did not match `created in_last_days 1`.
//
// The whole reason it shipped is that every other date test INHERITS the
// server's timezone, and CI's is UTC — the one arrangement under which the
// bug is invisible. So this suite does not trust the environment: it runs each
// assertion inside a transaction that has `SET LOCAL TIME ZONE` to an extreme
// fixed-offset zone, and requires the answer to be identical to UTC's.
//
// WHY THESE TWO ZONES, and why both. A zone shifts the session's calendar date
// away from UTC's only for part of the day, so no single zone reproduces the
// defect at every wall-clock hour. `Etc/GMT+12` (UTC−12) and `Etc/GMT-12`
// (UTC+12) are chosen because between them one is ALWAYS shifted: before 12:00
// UTC the west zone is a day behind, from 12:00 UTC the east zone is a day
// ahead. Both are fixed-offset (no DST), so the pair is deterministic at every
// hour of every day — which is what makes this a regression guard rather than
// a test that happens to pass on the clock that ran it.

const ZONES = ['UTC', 'Etc/GMT+12', 'Etc/GMT-12'] as const;

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "custom_field_value", "custom_field_option", "custom_field_definition", ' +
      '"work_item_revision", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** The DATABASE's own UTC calendar day — the anchor the fixture is built around. */
async function utcTodayInDb(): Promise<string> {
  const rows = await db.$queryRaw<{ day: string }[]>(
    Prisma.sql`SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day`,
  );
  return rows[0]!.day;
}

interface Seeded {
  fx: WorkItemFixture;
  ids: Record<'justNow' | 'dayMinus1' | 'day0' | 'dayPlus1', string>;
  goliveFieldId: string;
  referents: ProjectFilterReferents;
  utcToday: string;
}

/**
 * Four issues pinned to UTC calendar days around "today":
 *
 *   justNow   — createdAt = the real current instant · no due date, no CF value
 *   dayMinus1 — createdAt / dueDate / go-live = yesterday (UTC)
 *   day0      — createdAt / dueDate / go-live = today (UTC)
 *   dayPlus1  — createdAt / dueDate / go-live = tomorrow (UTC)
 *
 * `justNow` is the card's headline symptom in fixture form: a row created a
 * second ago must fall inside `created in_last_days 1` in every timezone.
 */
async function seed(utcToday: string): Promise<Seeded> {
  const fx = await makeFixture();

  const dayAt = (offset: number): Date =>
    new Date(Date.parse(`${utcToday}T00:00:00.000Z`) + offset * 86_400_000);

  const justNow = await createWorkItem(fx, { kind: 'bug', title: 'Created a moment ago' });
  const dayMinus1 = await createWorkItem(fx, { kind: 'task', title: 'Yesterday' });
  const day0 = await createWorkItem(fx, { kind: 'task', title: 'Today' });
  const dayPlus1 = await createWorkItem(fx, { kind: 'task', title: 'Tomorrow' });

  const dated = [
    [dayMinus1, -1],
    [day0, 0],
    [dayPlus1, 1],
  ] as const;

  for (const [item, offset] of dated) {
    await db.workItem.update({
      where: { id: item.id },
      data: { createdAt: dayAt(offset), dueDate: dayAt(offset) },
    });
  }

  const golive = await db.customFieldDefinition.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'golive',
      label: 'Go-live',
      fieldType: 'date',
      position: 'a0',
    },
  });
  await db.customFieldValue.createMany({
    data: dated.map(([item, offset]) => ({
      workspaceId: fx.workspaceId,
      workItemId: item.id,
      fieldId: golive.id,
      valueDate: dayAt(offset),
    })),
  });

  return {
    fx,
    ids: {
      justNow: justNow.identifier,
      dayMinus1: dayMinus1.identifier,
      day0: day0.identifier,
      dayPlus1: dayPlus1.identifier,
    },
    goliveFieldId: golive.id,
    referents: {
      customFields: new Map([[golive.id, { fieldType: 'date' as const, optionIds: new Set() }]]),
      labelIds: new Set(),
      componentIds: new Set(),
    },
    utcToday,
  };
}

/**
 * Run the compiled predicate against real Postgres with the session timezone
 * pinned. `SET LOCAL` binds the setting to this transaction, and an
 * interactive `$transaction` holds ONE pooled connection for the whole
 * callback — which is what makes the pin reliable where a bare
 * `SET TIME ZONE` on a pooled client would land on an arbitrary connection.
 */
async function matchesUnder(zone: string, s: Seeded, ast: FilterAst): Promise<string[]> {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`);
    const predicate = compileFilterConditionsSql(ast, s.referents);
    const rows = await tx.$queryRaw<{ identifier: string }[]>(
      Prisma.sql`SELECT w."identifier"
                   FROM "work_item" w
                  WHERE w."projectId" = ${s.fx.projectId}
                    AND (${predicate})
                  ORDER BY w."key"`,
    );
    return rows.map((r) => r.identifier).sort();
  });
}

function and(...conditions: FilterAst['conditions']): FilterAst {
  return { combinator: 'and', conditions };
}

/**
 * Seed and assert inside one UTC calendar day. The fixture is built around the
 * database's own UTC "today"; if the run straddles UTC midnight that anchor
 * stops being true mid-test, so re-read it afterwards and retry once on the
 * rollover rather than reporting a false failure (the fixed-window rule: align
 * to the boundary, don't pretend it isn't there).
 */
async function onOneUtcDay(body: (s: Seeded) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const utcToday = await utcTodayInDb();
    const seeded = await seed(utcToday);
    await body(seeded);
    if ((await utcTodayInDb()) === utcToday) return;
    await truncateAll();
  }
  throw new Error('UTC day rolled over on both attempts');
}

describe('relative date windows are anchored in UTC, never the session timezone', () => {
  it('built-in date fields select the same rows under every session timezone', async () => {
    await onOneUtcDay(async (s) => {
      const { justNow, dayMinus1, day0, dayPlus1 } = s.ids;

      for (const zone of ZONES) {
        // The card's headline symptom: a row created moments ago is inside
        // "the last 1 day" — under the bug it dropped out for part of the day.
        expect(
          await matchesUnder(
            zone,
            s,
            and({ field: 'created', operator: 'in_last_days', value: 1 }),
          ),
          `created in_last_days under ${zone}`,
        ).toEqual([dayMinus1, day0, justNow].sort());

        expect(
          await matchesUnder(zone, s, and({ field: 'due', operator: 'in_last_days', value: 1 })),
          `due in_last_days under ${zone}`,
        ).toEqual([dayMinus1, day0].sort());

        expect(
          await matchesUnder(zone, s, and({ field: 'due', operator: 'in_next_days', value: 1 })),
          `due in_next_days under ${zone}`,
        ).toEqual([day0, dayPlus1].sort());
      }
    });
  });

  it('custom-field date values select the same rows under every session timezone', async () => {
    await onOneUtcDay(async (s) => {
      const { dayMinus1, day0, dayPlus1 } = s.ids;
      const golive = customFieldFilterFieldId(s.goliveFieldId) as `cf:${string}`;

      for (const zone of ZONES) {
        expect(
          await matchesUnder(zone, s, and({ field: golive, operator: 'in_last_days', value: 1 })),
          `cf in_last_days under ${zone}`,
        ).toEqual([dayMinus1, day0].sort());

        expect(
          await matchesUnder(zone, s, and({ field: golive, operator: 'in_next_days', value: 1 })),
          `cf in_next_days under ${zone}`,
        ).toEqual([day0, dayPlus1].sort());
      }
    });
  });

  it('the absolute operators were never session-dependent, and stay UTC-day', async () => {
    // The recorded decision beside UTC_TODAY_SQL: a client 'YYYY-MM-DD' means a
    // UTC calendar day — the same meaning the relative windows now carry and
    // the one lib/utils/datetime.ts renders. Pinned here so a future change to
    // viewer-local semantics has to break a test rather than drift in.
    await onOneUtcDay(async (s) => {
      const { justNow, dayMinus1, day0 } = s.ids;

      for (const zone of ZONES) {
        expect(
          await matchesUnder(
            zone,
            s,
            and({ field: 'created', operator: 'on_or_before', value: s.utcToday }),
          ),
          `created on_or_before under ${zone}`,
        ).toEqual([dayMinus1, day0, justNow].sort());

        expect(
          await matchesUnder(
            zone,
            s,
            and({ field: 'due', operator: 'on_or_after', value: s.utcToday }),
          ),
          `due on_or_after under ${zone}`,
        ).toEqual([day0, s.ids.dayPlus1].sort());
      }
    });
  });
});
