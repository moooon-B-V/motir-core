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

  it('splits into two columns balanced by ROWS — the height MOTIR-2578 measured', () => {
    // The asset measured the modal at 836px resting / 938px at its tallest with
    // a 3/3 ROW split. Balancing the five domains by group COUNT instead gives
    // 4 rows against 2 (because `work_item` holds two permissions), which is
    // both lopsided and taller than what was measured — so the balance is
    // asserted on rows, and pinned, rather than left to drift with the catalog.
    //
    // ⚠️ 2026-08-18 (MOTIR-2988): the grantable set grew from six keys to SEVEN.
    // `ai:view_plan` was in the catalog but ungrantable, because no
    // token-reachable operation asserted it; `add_plan_items` is the first that
    // does, and `GRANTABLE_PERMISSIONS` is DERIVED from exactly that. So the
    // balanced split is now 4/3 and the taller column carries one more row than
    // the asset measured. That is a real consequence for the modal's height, and
    // it is pinned here rather than absorbed: the PROPERTY (balanced within one
    // row, no group broken across the columns) is what the layout rule is, and
    // the NUMBERS are what someone has to look at again if the set grows further.
    //
    // ⚠️ 2026-08-20 (MOTIR-3188): SEVEN to EIGHT, and this is the "someone has to
    // look again" the note above asked for. `ai:decide_plan` — plan approval,
    // split off `ai:view_plan` — is grantable through MOTIR-3021's one v1
    // entrance, so the split is now 4/4: BALANCED, and one row taller on the
    // shorter column than the asset measured. The `ai` domain group is what grew,
    // and it is not broken across the columns (the assertion below proves that).
    // The modal is one row taller than 938px at its tallest; re-measure the asset
    // when the set next grows, rather than letting the numbers drift untouched.
    //
    // ⚠️ 2026-08-25 (MOTIR-3361): EIGHT to NINE, and this is the next "look
    // again". `add_lesson` is the first MCP tool to assert `lesson:manage`, so
    // that key became grantable by the same derivation `ai:view_plan` arrived
    // through. The group that grew is **project** — `project:browse` +
    // `lesson:manage`, since a lesson belongs to a project — and the split is now
    // 5/4: still balanced within one row, still no group broken across the
    // columns, and one row taller again on the LEFT.
    //
    // The same card also had to MOVE the two lesson keys in the catalog to sit
    // beside `project:browse`. They were appended at the end while carrying
    // `domain: 'project'`, which broke the contiguity every other domain keeps —
    // harmless only for as long as neither key was grantable. The two
    // order-preservation assertions in this file are what caught it.
    const [left, right] = permissionColumnsForTokens();
    const rows = (gs: PermissionDomainGroup[]) => gs.reduce((n, g) => n + g.permissions.length, 0);
    expect(Math.abs(rows(left) - rows(right))).toBeLessThanOrEqual(1);
    expect(rows(left) + rows(right)).toBe(GRANTABLE_PERMISSIONS.length);
    //
    // ⚠️ 2026-08-25 (MOTIR-3480): NINE to TEN, and the next "look again".
    // `search_lessons` is the first MCP tool to assert `lesson:view`, so that key
    // became grantable by the same derivation `lesson:manage` and `ai:view_plan`
    // arrived through — and the **project** group grew again, to three
    // (`project:browse` + the two lesson keys, which the catalog keeps contiguous
    // beside it). The split is now 5/5: EXACTLY balanced for the first time since
    // MOTIR-2578 measured the asset, with the RIGHT column taking the new row and
    // the left unchanged. No group is broken across the columns (the assertion
    // below proves that).
    //
    // ⚠️ 2026-08-26 (MOTIR-3553): TEN to ELEVEN, and the next "look again".
    // `reinforce_lesson` is the first MCP tool to assert `lesson:reinforce`, so
    // that key became grantable by the same derivation the three before it
    // arrived through — and the **project** group grew again, to four
    // (`project:browse` + the three lesson keys, which the catalog keeps
    // contiguous beside it). The split is 6/5, with the LEFT column taking the
    // new row and the right unchanged: still balanced within one row, still no
    // group broken across the columns (the assertion below proves it), and the
    // three invariants above — balance, totality, no split group — are what
    // actually hold this. The two literals are a TRIPWIRE on the numbers, not a
    // second statement of the rule.
    //
    // ⚠️ THE ASSET IS NOW THREE ROWS BEHIND, not two. The note above asked for a
    // re-measure "when the set next grows", and it has now grown three times
    // since MOTIR-2578 measured it. That is a DESIGN card, not this one —
    // recorded here and surfaced on the pull request rather than absorbed
    // silently, because the numbers below going green is exactly what would
    // otherwise hide it.
    expect(rows(left)).toBe(6);
    expect(rows(right)).toBe(5);
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
