// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_META,
  domainLabelKey,
  permissionLabelKeys,
  permissionsByDomainForTokens,
  permissionColumnsForTokens,
  type PermissionDomainGroup,
  grantedPermissionMeta,
  grantsDelete,
  summarizeGrant,
} from '@/app/(authed)/settings/account/_components/permissionMeta';
import {
  DEFAULT_TOKEN_GRANT,
  GRANTABLE_PERMISSIONS,
  IRREVERSIBLE_PERMISSIONS,
} from '@/lib/tokens/grant';
import { permissionSlug } from '@/lib/permissions/catalog';
import enMessages from '@/messages/en.json';
import zhMessages from '@/messages/zh.json';

// The shared permission PRESENTER (Story MOTIR-2572 · Subtask MOTIR-2579) —
// the one module the create modal, the token list and the /device approval
// screen all read, so the three cannot describe the same grant differently.
//
// The property under test throughout is that it presents and DERIVES, and
// authors nothing: no label, no description, no grouping of its own.

const COPY = enMessages.permissions as unknown as Record<
  string,
  { label: string; description: string }
>;

describe('PERMISSION_META — derived from the grantable set, never hand-listed', () => {
  it('carries exactly the grantable keys, in catalog order', () => {
    expect(PERMISSION_META.map((m) => m.key)).toEqual([...GRANTABLE_PERMISSIONS]);
  });

  it('gives every row an icon and flags exactly the irreversible ones as danger', () => {
    for (const meta of PERMISSION_META) {
      expect(meta.Icon, `${meta.key} needs an icon`).toBeTruthy();
      expect(Boolean(meta.danger)).toBe(IRREVERSIBLE_PERMISSIONS.includes(meta.key));
    }
    expect(PERMISSION_META.filter((m) => m.danger).map((m) => m.key)).toEqual([
      ...IRREVERSIBLE_PERMISSIONS,
    ]);
  });

  it('names i18n keys that RESOLVE — in both locales', () => {
    for (const meta of PERMISSION_META) {
      const keys = permissionLabelKeys(meta.key);
      expect(keys.label).toBe(`${permissionSlug(meta.key)}.label`);
      expect(keys.description).toBe(`${permissionSlug(meta.key)}.description`);
      // The module's own `labelKey` is the FULLY-QUALIFIED path (a caller with
      // no `permissions` namespace uses it directly); `permissionLabelKeys`
      // returns the leaf, for a caller already scoped to that namespace. Both
      // must point at the same string.
      expect(meta.labelKey).toBe(`permissions.${keys.label}`);
      expect(meta.descriptionKey).toBe(`permissions.${keys.description}`);
      // …and both must actually be shipped, or the picker renders a raw key.
      for (const messages of [enMessages, zhMessages]) {
        const entry = (
          messages.permissions as unknown as Record<
            string,
            { label?: string; description?: string }
          >
        )[permissionSlug(meta.key)];
        expect(entry?.label).toBeTruthy();
        expect(entry?.description).toBeTruthy();
      }
    }
  });

  it('names a domain heading key that resolves', () => {
    const domains = new Set(PERMISSION_META.map((m) => m.domain));
    const shipped = enMessages.permissions.domain as unknown as Record<string, string>;
    for (const domain of domains) {
      expect(domainLabelKey(domain)).toBe(`domain.${domain}`);
      expect(shipped[domain], `permissions.domain.${domain}`).toBeTruthy();
    }
  });
});

describe('permissionsByDomainForTokens — the picker’s columns', () => {
  it('groups by the CATALOG’s domains, drops none of the keys, and keeps order', () => {
    const groups = permissionsByDomainForTokens();
    expect(groups.flatMap((g) => g.permissions.map((p) => p.key))).toEqual([
      ...GRANTABLE_PERMISSIONS,
    ]);
    // Every group is non-empty, and no domain appears twice (which would split
    // one heading across two columns).
    const seen = new Set<string>();
    for (const g of groups) {
      expect(g.permissions.length).toBeGreaterThan(0);
      expect(seen.has(g.domain)).toBe(false);
      seen.add(g.domain);
      for (const p of g.permissions) expect(p.domain).toBe(g.domain);
    }
  });

  it('splits into two columns by the RULE the design states — whole groups, first past half', () => {
    // ⚠️ THIS ASSERTS A RULE, NOT A COUNT — and that is the disposition
    // MOTIR-3580 took, on the record, after the count had been renewed five
    // times.
    //
    // What used to be here: two literals pinning the columns at the row counts
    // of the day, under a chain of six dated notes each saying the drawing that
    // measured them should be re-cut "when the set next grows". The set is
    // DERIVED (`GRANTABLE_PERMISSIONS` is computed from the operations a token
    // can reach), so it grows whenever a permission is minted — six times, on a
    // schedule nothing about this layout controls. Each growth turned the
    // literals red, and each time the note was renewed instead of discharged.
    //
    // `design/settings/permission-columns.mock.html` + its `design-notes.md`
    // section are where that chain now lives, as one statement instead of six:
    // the asset DERIVES all seven historical splits from the single rule below,
    // which is the evidence that the rule is the durable half and the numbers
    // were the perishable one.
    //
    // THE RULE, exactly as `permissionColumnsForTokens` implements it:
    //   1. the unit is a domain GROUP, never a row — a group is never broken
    //      across the columns (asserted in the sibling test below);
    //   2. groups are taken in CATALOG ORDER, and the cut is the FIRST boundary
    //      at which the left column holds at least half the rows;
    //   3. balance is what that BUYS, not a constraint it is held to — the
    //      imbalance is whatever the group sizes allow.
    //
    // ⚠️ It is GREEDY, not minimal-imbalance, and the previous version of this
    // test said otherwise. MOTIR-3629 replaced a `<= 1` balance assertion —
    // correctly, it had stopped being reachable — with one asserting the split
    // takes "the one with the SMALLEST imbalance", described as "the rule the
    // splitter actually implements". It is not. At group sizes 5·5·1 the
    // implementation cuts 10/1 where the best non-breaking boundary is 5/6; the
    // two coincide at every cardinality the set has actually had, which is the
    // same kind of coincidence the `<= 1` assertion was retired for being. What
    // is asserted below is what the code does, so it cannot go stale against it.
    const groups = permissionsByDomainForTokens();
    const [left, right] = permissionColumnsForTokens();
    const rows = (gs: PermissionDomainGroup[]) => gs.reduce((n, g) => n + g.permissions.length, 0);
    const total = GRANTABLE_PERMISSIONS.length;

    // Totality: nothing is lost or duplicated by the split.
    expect(rows(left) + rows(right)).toBe(total);

    // Whole groups, in catalog order, cut at one boundary.
    expect([...left, ...right].map((g) => g.domain)).toEqual(groups.map((g) => g.domain));
    expect(left.length).toBeGreaterThan(0);

    // The cut is PAST half…
    expect(rows(left) * 2).toBeGreaterThanOrEqual(total);
    // …and it is the FIRST such boundary: dropping the left column's last group
    // would put it under half. Together these two pin the boundary uniquely, at
    // every cardinality, which is what the literals could only do at one.
    expect(rows(left.slice(0, -1)) * 2).toBeLessThan(total);

    // The consequence the design draws: the left column is never the shorter
    // one, so it is the column that sets the modal's height.
    expect(rows(left)).toBeGreaterThanOrEqual(rows(right));
  });

  it('loses no permission to the column split, and never breaks a group across one', () => {
    const [left, right] = permissionColumnsForTokens();
    expect([...left, ...right].flatMap((g) => g.permissions.map((p) => p.key))).toEqual([
      ...GRANTABLE_PERMISSIONS,
    ]);
    const domains = [...left, ...right].map((g) => g.domain);
    expect(new Set(domains).size).toBe(domains.length);
  });
});

describe('grantedPermissionMeta / grantsDelete — the list row’s chips and its danger pill', () => {
  it('returns the granted rows in catalog order and ignores the rest', () => {
    expect(grantedPermissionMeta(['ai:plan', 'project:browse']).map((m) => m.key)).toEqual([
      'project:browse',
      'ai:plan',
    ]);
    expect(grantedPermissionMeta([])).toEqual([]);
  });

  it('renders the granted rows with SHIPPED copy, not a table of its own', () => {
    for (const meta of grantedPermissionMeta(GRANTABLE_PERMISSIONS)) {
      expect(COPY[permissionSlug(meta.key)]!.label).toBeTruthy();
    }
  });

  it('flags an irreversible grant, and only that', () => {
    expect(grantsDelete(['work_item:delete'])).toBe(true);
    expect(grantsDelete([...DEFAULT_TOKEN_GRANT])).toBe(false);
    expect(grantsDelete([])).toBe(false);
  });
});

describe('summarizeGrant — the word Yue reads instead of a fraction', () => {
  it('classifies the four shapes', () => {
    expect(summarizeGrant([...GRANTABLE_PERMISSIONS])).toBe('full');
    expect(summarizeGrant([...DEFAULT_TOKEN_GRANT])).toBe('standard');
    expect(summarizeGrant(['project:browse'])).toBe('readonly');
    expect(summarizeGrant(['project:browse', 'work_item:delete'])).toBe('custom');
    expect(summarizeGrant([])).toBe('custom');
  });

  it('does not call a same-SIZED but different grant “standard”', () => {
    // The trap the size check invites: swap one key of the default for the
    // delete key and the count is unchanged. That grant is dangerous and must
    // never be summarised as the ordinary one.
    const sneaky = [...DEFAULT_TOKEN_GRANT.slice(0, -1), 'work_item:delete'] as const;
    expect(sneaky.length).toBe(DEFAULT_TOKEN_GRANT.length);
    expect(summarizeGrant([...sneaky])).toBe('custom');
  });

  it('has a word for every summary it can return', () => {
    const shipped = enMessages.settings.apiTokens.scopes.summary as unknown as Record<
      string,
      string
    >;
    for (const summary of ['full', 'standard', 'readonly', 'custom'] as const) {
      expect(typeof shipped[summary], `scopes.summary.${summary}`).toBe('string');
      expect(shipped[summary]).toBeTruthy();
    }
  });
});
