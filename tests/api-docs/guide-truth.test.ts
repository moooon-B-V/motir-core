import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADR_PATH,
  GUIDE_STEPS,
  POLICY_ADDITIVE,
  POLICY_FORBIDDEN,
  POLICY_SECTIONS,
  type GuideBlock,
} from '@/lib/apiDocs/guide';
import { EXAMPLE_TOKEN } from '@/lib/apiDocs/reference';
import { findV1Operation } from '@/lib/api/v1/openapi/registry';
import { isV1Status } from '@/lib/api/v1/openapi/statuses';
import { V1_SHARED_RESPONSE_HEADERS } from '@/lib/api/v1/openapi/headers';
import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@/lib/api/v1/pagination';
import { TOKEN_SCOPES } from '@/lib/mcp/scopes';

// The guide and the policy, CHECKED AGAINST THE THING THEY DESCRIBE
// (Story 11.4 · Subtask 11.4.8 — MOTIR-2189).
//
// The card's sharpest criterion: *"Every endpoint, parameter, status and header
// the guide names is asserted against the shipped API by a test — so the guide
// cannot document a route, a query parameter or a header that does not exist."*
//
// That is why `lib/apiDocs/guide.ts` declares each step's CLAIMS as data beside
// its words. A paragraph cannot be checked against a registry; `endpoint`,
// `parameters`, `statuses` and `headers` can. A guide that is slightly wrong
// burns a developer's first ten minutes, which is the whole budget of goodwill a
// new API gets — so it fails the build instead.

const REPO_ROOT = process.cwd();

/** Every line of code the guide shows, across all its steps. */
function codeBlocks(): { caption: string; code: string }[] {
  return GUIDE_STEPS.flatMap((step) =>
    step.blocks.filter(
      (block): block is Extract<GuideBlock, { kind: 'code' }> => block.kind === 'code',
    ),
  );
}

describe('the guide is TRUE of the shipped API', () => {
  it('walks all five steps, in the order the card fixes', () => {
    expect(GUIDE_STEPS.map((step) => step.id)).toEqual([
      'mint-a-token',
      'first-call',
      'paginate',
      'read-an-error',
      'rate-limits',
    ]);
  });

  it('names only endpoints that EXIST — every one resolves in the registry', () => {
    // The check the criterion is about. A step naming
    // `GET /api/v1/workitems` (no hyphen) fails here rather than in a reader's
    // terminal.
    for (const step of GUIDE_STEPS) {
      if (!step.endpoint) continue;
      const operation = findV1Operation(step.endpoint.method, step.endpoint.path);
      expect(
        operation,
        `step "${step.id}" documents ${step.endpoint.method} ${step.endpoint.path}, which no operation serves`,
      ).toBeDefined();
    }
  });

  it('names at least one endpoint — the sweep is not vacuous', () => {
    expect(GUIDE_STEPS.filter((step) => step.endpoint).length).toBeGreaterThan(2);
  });

  it('names only QUERY PARAMETERS that endpoint actually accepts', () => {
    for (const step of GUIDE_STEPS) {
      if (!step.endpoint || !step.parameters) continue;
      const operation = findV1Operation(step.endpoint.method, step.endpoint.path)!;
      const declared = operation.parameters.map((parameter) => parameter.name);
      for (const parameter of step.parameters) {
        expect(
          declared,
          `step "${step.id}" documents ?${parameter}= on ${step.endpoint.path}`,
        ).toContain(parameter);
      }
    }
  });

  it('names only statuses the v1 vocabulary documents', () => {
    for (const step of GUIDE_STEPS) {
      for (const status of step.statuses ?? []) {
        expect(isV1Status(status), `step "${step.id}" documents ${status}`).toBe(true);
      }
    }
  });

  it('names only headers the wrapper actually sets on a response', () => {
    const shipped = V1_SHARED_RESPONSE_HEADERS.map((header) => header.name);
    for (const step of GUIDE_STEPS) {
      for (const header of step.headers ?? []) {
        expect(shipped, `step "${step.id}" documents ${header}`).toContain(header);
      }
    }
  });

  it('shows the rate-limit headers the wrapper sets — ALL of them, none invented', () => {
    const step = GUIDE_STEPS.find((s) => s.id === 'rate-limits')!;
    expect([...(step.headers ?? [])].sort()).toEqual(
      V1_SHARED_RESPONSE_HEADERS.map((header) => header.name).sort(),
    );
    // …and the sample block shows each one, so the words and the code agree.
    const sample = step.blocks.find(
      (block): block is Extract<GuideBlock, { kind: 'code' }> =>
        block.kind === 'code' && block.caption === 'response headers',
    );
    for (const header of V1_SHARED_RESPONSE_HEADERS) {
      expect(sample?.code, `${header.name} missing from the sample`).toContain(header.name);
    }
  });

  it('states the REAL page limits, read from the pagination module', () => {
    const step = GUIDE_STEPS.find((s) => s.id === 'paginate')!;
    const prose = step.blocks
      .filter((block): block is Extract<GuideBlock, { kind: 'prose' }> => block.kind === 'prose')
      .map((block) => block.text)
      .join(' ');
    expect(prose).toContain(String(DEFAULT_PAGE_LIMIT));
    expect(prose).toContain(String(MAX_PAGE_LIMIT));
  });

  it('describes only scopes the product actually offers', () => {
    const prose = GUIDE_STEPS.find((s) => s.id === 'mint-a-token')!
      .blocks.filter(
        (block): block is Extract<GuideBlock, { kind: 'prose' }> => block.kind === 'prose',
      )
      .map((block) => block.text)
      .join(' ');
    // Every scope the step names is real…
    for (const named of prose.match(/`([a-z_]+:[a-z_]+|read)`/g) ?? []) {
      const scope = named.replaceAll('`', '');
      expect(TOKEN_SCOPES as readonly string[], `unknown scope "${scope}"`).toContain(scope);
    }
    // …and it does NOT advertise the one v1 refuses to expose.
    expect(prose).not.toContain('work_items:delete');
  });

  it('sends the reader to the SHIPPED token surface', () => {
    const prose = GUIDE_STEPS.find((s) => s.id === 'mint-a-token')!
      .blocks.filter(
        (block): block is Extract<GuideBlock, { kind: 'prose' }> => block.kind === 'prose',
      )
      .map((block) => block.text)
      .join(' ');
    expect(prose).toMatch(/API tokens/);
    // The page it points at exists — "link to it; do not describe a surface you
    // have not opened".
    expect(() =>
      readFileSync(join(REPO_ROOT, 'app/(authed)/settings/account/api-tokens/page.tsx'), 'utf8'),
    ).not.toThrow();
  });

  it('states that the cursor is OPAQUE and must not be parsed', () => {
    const callouts = GUIDE_STEPS.find((s) => s.id === 'paginate')!.blocks.filter(
      (block): block is Extract<GuideBlock, { kind: 'callout' }> => block.kind === 'callout',
    );
    expect(callouts.map((c) => c.text).join(' ')).toMatch(/OPAQUE/);
  });

  it('explains the totalCount ASYMMETRY, which is the thing that surprises people', () => {
    const prose = GUIDE_STEPS.find((s) => s.id === 'paginate')!
      .blocks.filter(
        (block): block is Extract<GuideBlock, { kind: 'prose' }> => block.kind === 'prose',
      )
      .map((block) => block.text)
      .join(' ');
    expect(prose).toContain('totalCount');
    // The three that DO carry one are exactly the three the registry declares as
    // ranked — so the guide cannot claim the wrong collections.
    for (const [method, path] of [
      ['GET', '/api/v1/projects/{projectKey}/backlog'],
      ['GET', '/api/v1/sprints/{sprintId}/work-items'],
      ['GET', '/api/v1/work-items/{key}/comments'],
    ] as const) {
      expect(findV1Operation(method, path)?.response.body.kind).toBe('rankedPage');
    }
    expect(prose).toMatch(/backlog/);
    expect(prose).toMatch(/comments/);
    expect(prose).toMatch(/ready set/);
  });

  it('uses the bearer PLACEHOLDER in every runnable sample, never a fake token', () => {
    const runnable = codeBlocks().filter((block) => block.caption.startsWith('curl'));
    expect(runnable.length).toBeGreaterThan(2);
    for (const block of runnable) {
      expect(block.code, block.caption).toContain(`Authorization: Bearer ${EXAMPLE_TOKEN}`);
      expect(block.code, block.caption).not.toMatch(/motir_pat_[a-z0-9]{8,}/);
    }
  });

  it('calls the endpoint its step DECLARED, in every runnable sample', () => {
    // The words, the declared claim and the pasted command are three things that
    // can drift apart; this pins the third to the first.
    for (const step of GUIDE_STEPS) {
      if (!step.endpoint) continue;
      const path = step.endpoint.path.replace('{projectKey}', 'MOTIR').replace('{key}', '');
      const samples = step.blocks.filter(
        (block): block is Extract<GuideBlock, { kind: 'code' }> =>
          block.kind === 'code' && block.caption.startsWith('curl'),
      );
      for (const sample of samples) {
        expect(sample.code, `${step.id}: ${sample.caption}`).toContain(path.replace(/\/$/, ''));
      }
    }
  });

  it('quotes a URL carrying a query string, so a pasted sample cannot self-background', () => {
    for (const block of codeBlocks()) {
      if (!block.code.includes('?')) continue;
      expect(block.code, block.caption).toMatch(/curl "https/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The policy page against ADR §8
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ADR §8's text, from its heading to the next `###`, FLATTENED.
 *
 * Whitespace is collapsed and typographic apostrophes normalised, because the
 * ADR is prose that prettier re-wraps: a phrase this test looks for can land
 * across a line break, and “a field’s type” is the same promise as "a field's
 * type". Comparing on the flattened text checks the CONTENT of §8 rather than
 * its current line wrapping — otherwise re-flowing a paragraph would fail a
 * check about the stability policy, and the check would be deleted.
 */
function adrSection8(): string {
  const adr = readFileSync(join(REPO_ROOT, ADR_PATH), 'utf8');
  const start = adr.indexOf('### 8. Stability');
  expect(start, 'ADR §8 not found — did the heading change?').toBeGreaterThan(-1);
  const end = adr.indexOf('### 9.', start);
  return adr
    .slice(start, end === -1 ? undefined : end)
    .toLowerCase()
    .replaceAll('\u2019', "'")
    .replace(/\s+/g, ' ');
}

describe('the published policy and ADR §8 are ONE promise', () => {
  const section8 = adrSection8();

  it('found a real §8 to compare against', () => {
    expect(section8.length).toBeGreaterThan(400);
    expect(section8).toContain('additive-only');
  });

  it('publishes every item on §8’s ADDITIVE list', () => {
    for (const item of POLICY_ADDITIVE) {
      expect(section8, `"${item.adrPhrase}" is not in ADR §8`).toContain(item.adrPhrase);
    }
  });

  it('publishes every item on §8’s FORBIDDEN list', () => {
    for (const item of POLICY_FORBIDDEN) {
      expect(section8, `"${item.adrPhrase}" is not in ADR §8`).toContain(item.adrPhrase);
    }
  });

  it('has the SAME CARDINALITY as §8 — neither list may quietly grow or shrink', () => {
    // Phrase presence alone would let §8 gain a sixth allowance that the page
    // never publishes. Counting the semicolon-separated clauses in each bullet
    // catches that direction too.
    const additive = bullet(section8, '**allowed (additive):**');
    const forbidden = bullet(section8, '**forbidden without a new major:**');
    expect(clauseCount(additive)).toBe(POLICY_ADDITIVE.length);
    expect(clauseCount(forbidden)).toBe(POLICY_FORBIDDEN.length);
  });

  it('states the client’s obligation — the OTHER half of the promise', () => {
    const obligation = POLICY_SECTIONS.find((section) => section.id === 'your-obligation');
    const text = (obligation?.blocks ?? []).map((block) =>
      block.kind === 'prose' || block.kind === 'callout' ? block.text : '',
    );
    expect(text.join(' ')).toMatch(/tolerate unknown fields/);
    expect(text.join(' ')).toMatch(/unknown enum values/);
    // …and §8 says the same, so this is not a promise the page invented.
    expect(section8).toContain('tolerate unknown fields');
  });

  it('states the deprecation channel, the window and the v2 path', () => {
    const prose = POLICY_SECTIONS.flatMap((section) =>
      section.blocks.map((block) =>
        block.kind === 'prose' || block.kind === 'callout' ? block.text : '',
      ),
    ).join(' ');
    expect(prose).toContain('deprecated: true');
    expect(prose).toMatch(/announced window/);
    expect(prose).toMatch(/alongside `v1`/);
    expect(prose).toMatch(/never removed as a surprise|never removed/);
  });

  it('cross-links the ADR — and the ADR points back at the page', () => {
    expect(ADR_PATH).toBe('docs/decisions/public-api-conventions.md');
    // The ADR→page half, added by Amendment 4. Without it a reader who finds §8
    // has no way to know a published version exists.
    expect(section8).toContain('/docs/stability');
  });
});

/** One §8 bullet's body, from its bold label to the sentence's end. */
function bullet(section: string, label: string): string {
  const start = section.indexOf(label);
  expect(start, `the "${label}" bullet moved`).toBeGreaterThan(-1);
  const body = section.slice(start + label.length);
  const end = body.indexOf('. -');
  return end === -1 ? body.slice(0, body.indexOf('.') + 1) : body.slice(0, end + 1);
}

/** How many `;`-separated clauses a §8 bullet lists. */
function clauseCount(body: string): number {
  return body.split(';').filter((clause) => clause.trim().length > 0).length;
}
