import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The guard that outlives MOTIR-2542, and the reason it is a source assertion
// rather than a behavioural one.
//
// The defect was a surface reading `hasPaidAiPlan` directly off an `AiAccessDTO`
// whose `applicable: false` says every other field on it is inert. That is not
// missing coverage — the settings page was fully rendered by its tests — it is a
// SHAPE nobody was watching. A percentage cannot notice a future page reaching
// past `hasAiEntitlement` to the raw field again, because the wrong code is
// perfectly exercised.
//
// So the check is: which files are allowed to name that field at all. Two are —
// the DTO that declares it, and the predicate module that encapsulates reading
// it. Everything else asks the predicate.

// The rule is NOT "nobody may name the field" — writing it that way was the
// first draft and this guard immediately caught it. `AiPaywall` reads
// `hasPaidAiPlan` legitimately, to tell "a paying org has run out of credits"
// from "this org never bought AI" — but it reads it INSIDE the branch where
// `isAiPaywallApplicable` is already true, which is exactly what makes the read
// meaningful. The defect was reading it with no such branch at all.
//
// So there are two rules, and the difference between them is the whole finding:

/**
 * Surfaces that ask "is this organization ENTITLED?" — a question the sentinel
 * answers wrongly if you read a raw field. They must not name it at all.
 */
const MUST_NOT_READ = ['app/(authed)/settings/organization/page.tsx'];

/**
 * Surfaces that ask "WHICH paywall do I render?" — a question that only arises
 * once applicability is established. They may read the field, but only if they
 * also establish applicability through the shared predicate.
 */
const MAY_READ_WHEN_GATED = ['components/ai/AiPaywall.tsx'];

function code(file: string): string {
  // Strip comments so the prose explaining the rule cannot trip it.
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the entitlement read is encapsulated', () => {
  it.each(MUST_NOT_READ)('%s never reads `hasPaidAiPlan` — it asks the predicate', (file) => {
    expect(code(file)).not.toContain('hasPaidAiPlan');
    expect(code(file)).toContain('hasAiEntitlement');
  });

  it.each(MAY_READ_WHEN_GATED)('%s reads it only behind the applicability gate', (file) => {
    const src = code(file);
    if (!src.includes('hasPaidAiPlan')) return; // reading it is optional
    // If it reads the field, it must establish applicability through the shared
    // predicate rather than re-deriving `access?.applicable === true` inline —
    // an inline re-derivation is how the two consumers drifted apart before.
    expect(src).toContain('isAiPaywallApplicable');
  });

  it('every consumer routes through the predicate module', () => {
    for (const file of [...MUST_NOT_READ, ...MAY_READ_WHEN_GATED]) {
      expect(readFileSync(file, 'utf8')).toContain('@/lib/billing/aiEntitlement');
    }
  });
});

describe('the removed Organization URL copy left no orphan', () => {
  const catalogues = ['messages/en.json', 'messages/zh.json'] as const;

  it.each(catalogues)('%s carries neither urlLabel nor urlHint under orgAdmin.settings', (file) => {
    const json = JSON.parse(readFileSync(file, 'utf8')) as {
      orgAdmin?: { settings?: Record<string, unknown> };
    };
    const settings = json.orgAdmin?.settings ?? {};
    expect(Object.keys(settings)).not.toContain('urlLabel');
    expect(Object.keys(settings)).not.toContain('urlHint');
  });

  it('both catalogues still agree key-for-key', () => {
    const flat = (o: unknown, p = ''): string[] =>
      o && typeof o === 'object'
        ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) =>
            v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`],
          )
        : [];
    const en = new Set(flat(JSON.parse(readFileSync('messages/en.json', 'utf8'))));
    const zh = new Set(flat(JSON.parse(readFileSync('messages/zh.json', 'utf8'))));
    expect([...en].filter((k) => !zh.has(k))).toEqual([]);
    expect([...zh].filter((k) => !en.has(k))).toEqual([]);
  });
});
