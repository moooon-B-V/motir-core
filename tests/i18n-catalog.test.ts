import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { locales } from '@/lib/i18n/locales';
import { PLATFORM_AUDIT_ACTION_KEYS, reasonPolicyFor } from '@/lib/platform/auditActions';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';

// Collect EVERY key path that appears more than once at the same object level in
// the RAW catalog text. `import … from '*.json'` (and `JSON.parse`) silently keep
// only the LAST of duplicate keys, so a second `"aiPlanning": { … }` block
// shadows the first with NO parse error and NO key-set drift — invisible to the
// parity check below. That is exactly what shipped a broken plan-review surface
// (MOTIR-847 added a duplicate top-level `aiPlanning`, shadowing all its keys, so
// every <PlanItemNode> rendered raw i18n keys; MOTIR-1373). Parse the text with a
// reviver-free duplicate detector so the shadow surfaces as a unit failure.
function duplicateKeyPaths(jsonText: string): string[] {
  const dups: string[] = [];
  const stack: { path: string; seen: Set<string> }[] = [{ path: '', seen: new Set() }];
  // A minimal JSON tokenizer: we only need to know, at each `"key":` that is
  // immediately followed by a value in an OBJECT, whether the key repeats at the
  // current nesting level. Track container starts/ends and string keys.
  let i = 0;
  const n = jsonText.length;
  const isObjectStack: boolean[] = [];
  while (i < n) {
    const ch = jsonText[i];
    if (ch === '"') {
      // read a string token
      let j = i + 1;
      let str = '';
      while (j < n) {
        const c = jsonText[j];
        if (c === '\\') {
          str += jsonText[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') break;
        str += c;
        j += 1;
      }
      // is this string a KEY? (next non-space char is ':' and we're in an object)
      let k = j + 1;
      while (k < n && /\s/.test(jsonText[k]!)) k += 1;
      const inObject = isObjectStack[isObjectStack.length - 1];
      if (jsonText[k] === ':' && inObject) {
        const top = stack[stack.length - 1]!;
        const full = top.path ? `${top.path}.${str}` : str;
        if (top.seen.has(str)) dups.push(full);
        else top.seen.add(str);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      isObjectStack.push(true);
      const top = stack[stack.length - 1]!;
      // the path of this new object is whatever key most recently preceded it;
      // approximate via the last seen key at the parent level (good enough for
      // reporting — correctness of detection does not depend on it).
      stack.push({ path: top.path, seen: new Set() });
    } else if (ch === '[') {
      isObjectStack.push(false);
    } else if (ch === '}') {
      isObjectStack.pop();
      stack.pop();
    } else if (ch === ']') {
      isObjectStack.pop();
    }
    i += 1;
  }
  return dups;
}

// Guards the message catalogs against drift: every locale must define EXACTLY
// the same set of (nested) keys as the base `en` catalog — no missing keys (a
// missing-message runtime error in the other locale) and no orphan keys (dead
// translations). next-intl throws on a missing key in dev, so a parity gap would
// surface as a render crash for `zh` users; this turns it into a fast unit
// failure at the catalog level instead.

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? flatten(value as Record<string, unknown>, path)
      : [path];
  });
}

// Like `flatten`, but returns [keyPath, stringValue] pairs so a test can assert
// on the actual rendered copy (not just the key set).
function flattenEntries(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return flattenEntries(value as Record<string, unknown>, path);
    }
    return typeof value === 'string' ? [[path, value]] : [];
  });
}

describe('message catalogs', () => {
  const enKeys = flatten(en).sort();

  it('ships a catalog per declared locale', () => {
    // `en` and `zh` are the two declared locales; both are imported here.
    expect(locales).toContain('en');
    expect(locales).toContain('zh');
  });

  it('zh has the exact same key set as en (no missing, no orphan keys)', () => {
    const zhKeys = flatten(zh as Record<string, unknown>).sort();
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k));
    const orphanInZh = zhKeys.filter((k) => !enKeys.includes(k));
    expect(missingInZh, `keys missing from zh.json: ${missingInZh.join(', ')}`).toEqual([]);
    expect(orphanInZh, `orphan keys in zh.json: ${orphanInZh.join(', ')}`).toEqual([]);
  });

  // The parity check above parses the JSON, so duplicate keys are already
  // collapsed (last wins) and invisible to it. Detect them on the RAW text so a
  // shadowing duplicate (the MOTIR-1373 cause) fails loudly instead of silently
  // dropping a whole namespace.
  it.each(['en', 'zh'])('%s.json has no duplicate keys at any level', (locale) => {
    const raw = readFileSync(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8');
    const dups = duplicateKeyPaths(raw);
    expect(dups, `duplicate keys in ${locale}.json: ${dups.join(', ')}`).toEqual([]);
  });
});

// Regression guard for `bug-zh-dashboards-reports-stale-glossary`: the locked zh
// PM glossary BANS `仪表板` for "dashboard" (must be `工作台`) and `问题` for the
// tracked-unit noun "work item" (must be `工作项`). Both had leaked into the
// dashboards/reports copy. Note: `问题` is ALSO legitimate Chinese for "problem"
// in the `出了点问题` / `出现问题` error idioms — those are NOT work items and must
// stay, so the `问题` check is scoped to the `dashboards` namespace, where every
// occurrence denoted a tracked unit (no error idioms live there).
describe('zh glossary (locked terms)', () => {
  const zhEntries = flattenEntries(zh as Record<string, unknown>);

  it('never renders the banned `仪表板`; "dashboard" is always `工作台`', () => {
    const leaks = zhEntries.filter(([, value]) => value.includes('仪表板'));
    expect(
      leaks.map(([path]) => path),
      `banned 仪表板 (use 工作台) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
    // positive anchor: the dashboards landing title is the native term
    expect((zh as { dashboards: { title: string } }).dashboards.title).toBe('工作台');
  });

  it('never uses `问题` for the work-item noun in the dashboards namespace (use `工作项`)', () => {
    const leaks = zhEntries.filter(
      ([path, value]) => path.startsWith('dashboards.') && value.includes('问题'),
    );
    expect(
      leaks.map(([path]) => path),
      `banned work-item 问题 (use 工作项) at: ${leaks.map(([p]) => p).join(', ')}`,
    ).toEqual([]);
  });
});

// The product's noun for the thing a person plans and an agent works is a WORK
// ITEM. "card" is authoring-voice shorthand for it and had leaked into fifteen
// shipped `en` values and thirteen `zh` twins (MOTIR-3949) — so a reader met two
// nouns for one object with nothing on screen saying they are the same thing.
//
// The word does THREE jobs here and only one of them is the defect, so this is a
// keyed ALLOWLIST rather than a ban: a UI PANEL (a dashboard tile, the `Card`
// primitive) and a PAYMENT CARD are both correct and must survive. The predicate
// is the standalone WORD — `\bcards?\b` — which is what makes it cheap: it
// already excludes every `discard` / `Discarded` / `discardCta` value (19 of
// them in `en`) without an entry, because `discard` offers no left word
// boundary. A new value using "card" for a work item therefore fails here, and a
// new value about billing or a tile fails ONCE, with the fix being one reviewed
// line naming which of the two senses it is.
const CARD_SENSE_ALLOWLIST: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    'orgAdmin.seat.addSub': 'payment card — Stripe bills the seat to the card on file',
    'orgAdmin.seat.pastDueNote': 'payment card — the seat-plan charge failed',
    'billing.pastDue.banner': 'payment card — the AI-plan charge failed',
    'onboarding.landing.heroHint': 'payment card — "no credit card"',
    'platformAdmin.monitoring.subtitle': 'UI panel — the six monitoring tiles, each linking out',
  },
  zh: {
    'platformAdmin.monitoring.subtitle':
      'UI panel — 每张卡片 is a monitoring tile, not a work item',
  },
};

describe('product noun (a work item is never called a "card")', () => {
  it.each(['en', 'zh'] as const)(
    '%s.json uses "card" only for a panel or a payment card',
    (locale) => {
      const entries = flattenEntries((locale === 'en' ? en : zh) as Record<string, unknown>);
      const allow = CARD_SENSE_ALLOWLIST[locale];
      const leaks = entries.filter(
        ([path, value]) =>
          (/\bcards?\b/i.test(value) || value.includes('卡片')) && !(path in allow),
      );
      expect(
        leaks.map(([path]) => path),
        `"card" is not the product noun — say work item / item (zh: 工作项) at: ` +
          `${leaks.map(([p]) => p).join(', ')}. If a hit is a UI panel or a payment ` +
          `card, add it to CARD_SENSE_ALLOWLIST.${locale} with the sense.`,
      ).toEqual([]);
    },
  );

  it.each(['en', 'zh'] as const)('%s allowlist has no stale entry', (locale) => {
    const entries = new Map(flattenEntries((locale === 'en' ? en : zh) as Record<string, unknown>));
    const stale = Object.keys(CARD_SENSE_ALLOWLIST[locale]).filter((path) => {
      const value = entries.get(path);
      return value === undefined || !(/\bcards?\b/i.test(value) || value.includes('卡片'));
    });
    expect(
      stale,
      `allowlisted keys that no longer say "card": ${stale.join(', ')} — drop them`,
    ).toEqual([]);
  });
});

// A key whose NAME contains a `.` is not a naming preference — it is an
// UNRESOLVABLE key. next-intl reserves `.` for nesting, so it walks
// `platformAdmin.users.log.action.user.suspend` as six segments and never finds
// the five-segment literal the catalog actually holds; it also refuses such keys
// outright at provider construction (`INVALID_KEY`). The parity check above is
// structurally blind to this: `flatten` joins segments with `.`, so a literal
// `"user.suspend"` and a nested `user: { suspend }` flatten to the SAME path —
// both locales carried the same broken key, parity held, and the surface
// rendered raw key paths (MOTIR-3686, shipped by MOTIR-1167).
describe('catalog keys are resolvable (no `.` inside a key name)', () => {
  it.each(['en', 'zh'])('%s.json has no key containing a `.`', (locale) => {
    const messages = (locale === 'en' ? en : zh) as Record<string, unknown>;
    const dotted: string[] = [];
    const walk = (node: Record<string, unknown>, path: string[]) => {
      for (const [key, value] of Object.entries(node)) {
        if (key.includes('.')) dotted.push([...path, key].join(' → '));
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          walk(value as Record<string, unknown>, [...path, key]);
        }
      }
    };
    walk(messages, []);
    expect(
      dotted,
      `keys containing "." in ${locale}.json (next-intl reads "." as nesting, so these never resolve): ${dotted.join(', ')}`,
    ).toEqual([]);
  });
});

// The specific consequence the rule above prevents, asserted at the call site
// that suffers it. `/admin/users/[userId]` renders each audit row as
// `t(`users.log.action.${row.action}`)`, and `platformSupportService` filters
// that log to the OPERATOR WRITES — `reasonPolicyFor(action) === 'required'`.
// So the population that must carry a label is exactly the `required` members of
// `PLATFORM_AUDIT_ACTIONS`, and it GROWS: Story 10.3's governance actions each
// add one. Deriving the expected set from the vocabulary rather than listing it
// here is what makes a fourth support action unable to ship unlabelled.
describe('platform support-action labels resolve for every operator write', () => {
  const operatorWrites = PLATFORM_AUDIT_ACTION_KEYS.filter(
    (action) => reasonPolicyFor(action) === 'required',
  );

  it('has at least one operator write to check (the derivation is not vacuous)', () => {
    expect(operatorWrites.length).toBeGreaterThan(0);
  });

  it.each(['en', 'zh'])('%s labels every operator write in the support log', (locale) => {
    const messages = (locale === 'en' ? en : zh) as Record<string, unknown>;
    const errors: string[] = [];
    const t = createTranslator({
      locale,
      messages: messages as Parameters<typeof createTranslator>[0]['messages'],
      namespace: 'platformAdmin',
      onError: (error) => errors.push(`${error.code}: ${error.message}`),
      getMessageFallback: ({ key }) => `MISSING:${key}`,
    });

    // The two locale JSONs have different inferred types, so `messages` is
    // widened to a plain record above and next-intl can no longer type the key.
    // The lookup itself is byte-for-byte the page's: `users.log.action.` + the
    // raw action value, dots and all.
    const translate = t as unknown as (key: string) => string;
    const unresolved = operatorWrites.filter((action) =>
      translate(`users.log.action.${action}`).startsWith('MISSING:'),
    );

    expect(
      unresolved,
      `${locale}.json has no resolvable label for: ${unresolved.join(', ')} (add it under platformAdmin.users.log.action, nested so the lookup path matches)`,
    ).toEqual([]);
    expect(errors, `next-intl rejected the catalog: ${errors.join(' | ')}`).toEqual([]);
  });
});

// ── Work-item TYPE labels are a closed, single-word vocabulary (MOTIR-4249) ───
//
// The fourteen type labels are single words BY CONSTRUCTION (the grammar frozen
// in docs/decisions/work-item-type-taxonomy.md §1b), and that is exactly what
// makes them collide: `Legal`, `Copy`, `Manual`, `Design`, `Review`, `Content`
// are also ordinary UI nouns and verbs. The shipped defect was `shell.nav.legal`
// = "Legal" — the terms/privacy DOCUMENTS — sitting in the rail while
// `labels.workItemType.legal` = "Legal" named a kind of WORK. The `zh` catalog
// had already resolved the ambiguity (`法务` for the work, `法律条款` for the
// documents); English never had that forcing function and carried one word for
// both. MOTIR-4237 moved the rail row into the Help menu as `shell.help.legal` =
// "Legal documents" / `法律文件`, so the pair is gone. These guards keep it gone.
//
// TWO tiers, because the two populations are not the same risk:
//
//  A. THE SHELL IS A HARD BAN, no allowlist. The shell is the app CHROME — nav
//     rows, menus, breadcrumbs — the one place a label renders with NOTHING
//     around it to fix its sense. A rail row reading "Legal" among Boards /
//     Reports / Settings reads as a DESTINATION, which is the whole defect. An
//     allowlist here would be a way to re-ship it with a note attached.
//  B. EVERYWHERE ELSE IS A RATCHET with a written disposition per key. A type
//     label reused inside a `FieldCard label={…}`, or as a button verb on a
//     surface that renders no type chip at all, is disambiguated by its frame.
//     Eight `en` keys and six `zh` keys ship that way today; each carries its
//     reason below, and a ninth fails here until someone writes one.
//
// The label set is derived from `WORK_ITEM_TYPES` rather than listed, so a
// fifteenth enum member is covered the moment its label lands — and a type whose
// label goes MISSING fails the vacuity check instead of silently shrinking the
// population this guards.
const TYPE_LABEL_COLLISION_ALLOWLIST: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    // The clipboard VERB. A different part of speech from the `copy` type
    // (copywriting work, `文案` in zh — which is why zh never collides here), on
    // four surfaces that render no work-item type chip.
    'apiDocs.codeCopy': 'clipboard verb — copies a code sample on the API docs page',
    'codeHealth.deepen.copy': 'clipboard verb — copies the deepen audit prompt',
    'publicProjects.copyFeed': 'clipboard verb — copies the public feed URL',
    'settings.apiTokens.created.copy': 'clipboard verb — copies the new API token',
    'settings.public.copy': 'clipboard verb — copies the public project URL',
    // Named inside an explicit frame on a surface with no type chip.
    'codeHealth.convention.defaultRepo':
      'repo fallback name on Code health — the card header where a repoKey would sit',
    'onboarding.generation.designLabel':
      'field label "Design: <summary>" in the onboarding baseline card — pre-generation, no tree yet',
    // The ONE key that shares a surface with the type chip, and the reason it is
    // still not the `shell.nav.legal` shape: BOTH chips render inside the same
    // `FieldCard label={…}` primitive on the item detail rail — "Type: Manual"
    // (CoreFieldsPanel.tsx) versus "Planning: Manual" (ProvenanceSection.tsx) —
    // and the provenance chip's sibling values (Native · MCP · API · Hosted ·
    // BYOK) all name an ORIGIN, which fixes the sense the way the type set's own
    // siblings fix the other one. The nav row had no such frame. Weakest member
    // of this list: `zh` does NOT disambiguate it (`手动` both), so if a reader
    // is ever seen to trip on it the remedy is a design-owned relabel of the
    // provenance chip (design/work-items/provenance.mock.html draws it), not a
    // change to the closed type-label set.
    'issueViews.provenanceSourceManual':
      'provenance ORIGIN chip on the item detail rail — framed by FieldCard label "Planning"/"Implementation"',
  },
  zh: {
    // `验证` is the verification TYPE noun and also the ordinary button verb; en
    // splits these (Verify / Validate) and zh does not. All three are buttons on
    // surfaces that render no type chip.
    'auth.twoFactor.verify': 'button verb — submits the 2FA code',
    'settings.publicAddress.domains.addModal.verify': 'button verb — checks the domain DNS record',
    'roadmap.canvas.origin.validate': 'button verb — validates the canvas origin',
    // The en twins above, same reasons.
    'codeHealth.convention.defaultRepo': 'repo fallback name on Code health',
    'onboarding.generation.designLabel': 'field label in the onboarding baseline card',
    'issueViews.provenanceSourceManual': 'provenance ORIGIN chip, framed by its FieldCard label',
  },
};

const TYPE_LABEL_NAMESPACE = 'labels.workItemType.';

describe('work-item type labels do not silently name something else', () => {
  const catalogs = { en, zh } as Record<'en' | 'zh', Record<string, unknown>>;

  function typeLabels(locale: 'en' | 'zh'): Map<string, string> {
    const entries = new Map(flattenEntries(catalogs[locale]));
    return new Map(
      WORK_ITEM_TYPES.map((type) => [type, entries.get(`${TYPE_LABEL_NAMESPACE}${type}`)!]),
    );
  }

  it.each(['en', 'zh'] as const)(
    '%s labels all fourteen types (the derivation is real)',
    (locale) => {
      const labels = typeLabels(locale);
      const unlabelled = [...labels].filter(([, value]) => !value).map(([type]) => type);
      expect(
        unlabelled,
        `${locale}.json has no ${TYPE_LABEL_NAMESPACE}* label for: ${unlabelled.join(', ')}`,
      ).toEqual([]);
      expect(labels.size).toBe(WORK_ITEM_TYPES.length);
    },
  );

  // A. THE HARD BAN. No allowlist, deliberately — see the header above.
  it.each(['en', 'zh'] as const)('%s: no shell.* label reuses a type label', (locale) => {
    const labels = new Set([...typeLabels(locale).values()].map((v) => v.trim().toLowerCase()));
    const leaks = flattenEntries(catalogs[locale]).filter(
      ([path, value]) => path.startsWith('shell.') && labels.has(value.trim().toLowerCase()),
    );
    expect(
      leaks.map(([path, value]) => `${path} = ${value}`),
      `a shell (chrome) label renders a bare work-item TYPE label, which is the ` +
        `MOTIR-4249 defect — the rail teaches one sense and the chip means another. ` +
        `Give the shell row a two-word label (e.g. "Legal documents"): `,
    ).toEqual([]);
  });

  // B. THE RATCHET. Everywhere else, with a written disposition per key.
  it.each(['en', 'zh'] as const)('%s: every other reuse carries a disposition', (locale) => {
    const labels = new Map(
      [...typeLabels(locale)].map(([type, value]) => [value.trim().toLowerCase(), type]),
    );
    const allow = TYPE_LABEL_COLLISION_ALLOWLIST[locale];
    const leaks = flattenEntries(catalogs[locale]).filter(
      ([path, value]) =>
        !path.startsWith(TYPE_LABEL_NAMESPACE) &&
        labels.has(value.trim().toLowerCase()) &&
        !(path in allow),
    );
    expect(
      leaks.map(([path, value]) => `${path} = ${value}`),
      `these keys render a bare work-item TYPE label for something else. If the ` +
        `sense is fixed by the surrounding frame (a FieldCard label, a button on a ` +
        `surface with no type chip), add the key to ` +
        `TYPE_LABEL_COLLISION_ALLOWLIST.${locale} WITH the reason; otherwise rename it: `,
    ).toEqual([]);
  });

  it.each(['en', 'zh'] as const)('%s allowlist has no stale entry', (locale) => {
    const entries = new Map(flattenEntries(catalogs[locale]));
    const labels = new Set([...typeLabels(locale).values()].map((v) => v.trim().toLowerCase()));
    const stale = Object.keys(TYPE_LABEL_COLLISION_ALLOWLIST[locale]).filter((path) => {
      const value = entries.get(path);
      return value === undefined || !labels.has(value.trim().toLowerCase());
    });
    expect(
      stale,
      `allowlisted keys that no longer collide with a type label: ${stale.join(', ')} — drop them`,
    ).toEqual([]);
  });

  // The specific pair the card is about, asserted by value rather than by the
  // rules above, so a reader meeting this file sees what was actually wrong.
  it('`Legal` names the work TYPE and nothing else in en', () => {
    const legal = flattenEntries(en).filter(([, value]) => value.trim() === 'Legal');
    expect(legal.map(([path]) => path)).toEqual([`${TYPE_LABEL_NAMESPACE}legal`]);
  });

  it('zh keeps the split English had to be given: 法务 (the work) vs 法律文件 (the documents)', () => {
    const zhEntries = new Map(flattenEntries(zh as Record<string, unknown>));
    expect(zhEntries.get(`${TYPE_LABEL_NAMESPACE}legal`)).toBe('法务');
    expect(zhEntries.get('shell.help.legal')).toBe('法律文件');
    expect(zhEntries.get(`${TYPE_LABEL_NAMESPACE}legal`)).not.toBe(
      zhEntries.get('shell.help.legal'),
    );
  });
});
