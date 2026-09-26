import { describe, expect, it } from 'vitest';
import { PERMISSION_CATALOG } from '@/lib/permissions/catalog';
import { PROJECT_NAV_ACCESS } from '@/lib/settings/projectNavAccess';
import { SERVER_ACTION_GATES } from './writeControlPairing';

// MOTIR-6176 — the two cases of the write-control guard that read APP code, kept
// out of `writeControlGuard.test.ts` because that file runs in the
// structural-guards lane, which imports nothing under lib/, app/ or components/
// (`tests/ci-structural-guards-lane.test.ts`). Neither walks the tree.

describe('the pairing names real keys', () => {
  it.each(Object.entries(SERVER_ACTION_GATES).filter(([, g]) => g.kind === 'key'))(
    '%s',
    (_id, gate) => {
      if (gate.kind !== 'key') return;
      expect(PERMISSION_CATALOG[gate.key]).toBeDefined();
    },
  );
});

describe('3 · every navigation door names the key that opens its room', () => {
  it.each(PROJECT_NAV_ACCESS.map((e) => [e.href, e] as const))('%s', (_href, entry) => {
    if (entry.requires === 'browse-only') {
      // `browse-only` is a DECISION, so it carries the reading that supports it.
      expect(entry.evidence.trim().length, 'browse-only needs its evidence').toBeGreaterThan(20);
    } else if (typeof entry.requires === 'object') {
      // A ROOM door (MOTIR-6332): the view key OR a way to act — every key real.
      for (const key of entry.requires.anyOf) expect(PERMISSION_CATALOG[key], key).toBeDefined();
    } else {
      expect(PERMISSION_CATALOG[entry.requires]).toBeDefined();
    }
  });
});
