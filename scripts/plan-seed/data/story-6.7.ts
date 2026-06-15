import type { PlanStory } from '../types';

/**
 * Story 6.7 — Tests: the combined Epic-6 journey + search / reporting /
 * automation at scale.
 *
 * Re-scope note (deepening, 2026-06-10 — the Story 3.5 / 4.7 / 5.6 precedent,
 * applied verbatim). The stub framed 6.7 as "Vitest over filter→query
 * compilation (incl. injection safety), permission checks, automation
 * trigger/action; Playwright over build-a-filter, save it, gate a viewer,
 * fire a rule" — written when 6.7 was the ONLY Epic-6 test story. Since then:
 *
 *   - **6.1.6** owns the filter compile-correctness matrix, the injection
 *     fuzz suite, the serialization properties, and the build-a-filter E2E
 *     (its card already points "the epic-wide remainder" HERE).
 *   - **6.4.8** (Story 6.4 is DONE) owns the permission matrix — browse/edit
 *     per access level × role — and the focused gating E2E.
 *   - The remaining 6.x expansions (6.2 / 6.3 / 6.5 / 6.6 / 6.8) each carry
 *     their own closing test subtask when they expand — the canonical-depth
 *     invariant every story since Epic 2 has followed. Their closers own the
 *     per-surface coverage and MUST point the epic-wide journey at 6.7 (the
 *     6.1.6 context-ref note is the template).
 *
 * So 6.7 is scoped to the NON-duplicative remainder — the two things no
 * single story owns:
 *
 *   1. **The combined Epic-6 journey** — the stub's E2E sentence IS the seam
 *      list: build a filter (6.1) → SAVE it (6.2) → a dashboard widget
 *      consumes it (6.3) → a viewer is GATED (6.4 levels × the NEW Epic-6
 *      admin surfaces) → a rule FIRES (6.6) and its action lands as real
 *      history + notifications. Each story proves its own link; none proves
 *      the chain (a saved filter deleted under a live widget, an automation
 *      action that must read exactly like a real actor's edit to the Epic-5
 *      surfaces, the 6.4 roles applied to admin surfaces that did not exist
 *      when 6.4 shipped).
 *   2. **Search / reporting / automation at scale** — filters + saved
 *      filters + dashboard aggregations over a 10k-issue, time-spread corpus
 *      stay indexed and SQL-aggregated (finding #57: no load-all-then-reduce
 *      read anywhere on the reporting path), and a bulk transition sweep
 *      fires rules exactly once. The existing large fixtures are tree-shaped
 *      (2.5.16), board-shaped (3.5.1), sprint-shaped (4.7.1), and
 *      collaboration-shaped (5.6.1) — NONE builds time-spread
 *      created/resolved history, saved filters, dashboards, or rules; the
 *      same fixture gap every predecessor closed for its epic (hence 6.7.1).
 *
 * It does NOT re-test what an owning story covers in isolation (the operator
 * matrix + injection fuzz are 6.1.6's; the level × role browse/edit matrix is
 * 6.4.8's; the saved-filter CRUD, widget/report rendering, admin-hub
 * composition, rule-builder, and key-change behaviours belong to the future
 * 6.2 / 6.3 / 6.5 / 6.6 / 6.8 closers).
 *
 * 📦 Lives in Epic 6. Deps use STORY-LEVEL ids for the not-yet-expanded
 * siblings (6.2 / 6.3 / 6.5 / 6.6) — the 2.6.x / 6.4.3 precedent; a later
 * re-plan MAY retarget them to specific leaves once those stories expand —
 * plus backward Epic-5 leaves and 6.1.6 / 6.4. The cross-epic dependency
 * audit is clean: nothing points forward of Epic 6. All subtasks seed
 * `'blocked'` (every dep is unbuilt or still a stub).
 *
 * No design subtask: test-only story, no UI built (the 2.6 precedent — the
 * E2E drives surfaces the owning stories ship), so the design gate does not
 * fire. No manual/human subtask: the real-Postgres harness (:5433), the CI
 * Playwright lane, and the Inngest dev stub all exist (1.0 / 1.6 / the E2E
 * harness conventions) — no SaaS / secret / dashboard prerequisite.
 *
 * Recorded deviation (justified, rung-1 style): the 6.7.1 fixture seeds
 * through the shipped services (the no-raw-inserts rule) EXCEPT one
 * documented timestamp back-dating pass — created/resolved/revision
 * timestamps are server-set and no service accepts them, yet the time spread
 * is the very thing the 6.3 reports measure. The pass is confined to
 * `scripts/seed-reporting.ts`, touches timestamps only, and is asserted by
 * the fixture self-check.
 *
 * Expanded from its `stubs.ts` entry per `motir plan 6.7`, on the standing
 * `seed/epic-5-plan` branch (Epic-5/6 planning). Matches the canonical style
 * of 5.6 / 6.1.
 */
export const story_6_7: PlanStory = {
  id: '6.7',
  title:
    'Tests — the combined Epic-6 journey (build → save → gate → fire) + search/reporting/automation at scale',
  status: 'planned',
  descriptionMd:
    'The Epic-6 cross-cutting test story, re-scoped (the 3.5/4.7/5.6 precedent) to the ' +
    'non-duplicative remainder now that the per-story closers own their surfaces (6.1.6 — ' +
    'filter compilation + injection; 6.4.8, shipped — the access-level × role matrix; the ' +
    'future 6.2/6.3/6.5/6.6/6.8 closers — their own features). Two deliverables:\n\n' +
    "**1. The combined Epic-6 journey (6.7.2).** The stub's sentence, exercised as ONE flow " +
    'asserting the seams that only exist BETWEEN stories: an admin **builds** an advanced ' +
    'filter (negation + a custom-field row — the 6.1 surface), **saves and names it** (6.2), ' +
    'backs a **dashboard widget** with it (6.3), creates an **automation rule** from the ' +
    'built-in action set (6.6), and **transitions a matching issue** — the rule fires through ' +
    'the job lane, its action writes through the shipped services (History records it ' +
    'attributed to automation, the 5.4 watcher email fires with the dedupe contract intact, ' +
    'the saved-filter result set and the widget count track the change). Then the **gate**: a ' +
    'non-admin in a limited/private project (the shipped 6.4 levels) can use what the level ' +
    'grants but every Epic-6 ADMIN surface — saved-filter management, dashboard editing, the ' +
    'rule admin in the 6.5 hub — is hidden in the UI AND 403 at the API (the surfaces 6.4 ' +
    'could not test because they did not exist yet). Then the **unwind**: delete the saved ' +
    'filter under the live widget → the designed stale state (the 6.1 stale-referent ' +
    'durability rule, one story up), never a crash; disable the rule → no further firing; ' +
    'delete the rule → its History entries keep rendering via the deleted-referent fallback ' +
    '(the 5.5.1 grammar). Each story proves its own link; THIS spec proves the chain.\n\n' +
    '**2. Search / reporting / automation at scale (6.7.1 fixture + 6.7.3 specs).** A real ' +
    "team's project is years deep: thousands of issues spread over months of " +
    'created/resolved history. No existing fixture builds that shape (tree 2.5.16, board ' +
    '3.5.1, sprint 4.7.1, collab 5.6.1 — all current-dated, none carries saved filters / ' +
    'dashboards / rules). 6.7.1 builds the **reporting-shaped corpus** — 10k issues ' +
    '(cap-parameterised) time-spread across ~26 weeks with status/priority/assignee/kind/' +
    'label/component/custom-field spread, plus named saved filters, a populated dashboard, ' +
    'and enabled rules — through the shipped services (one recorded deviation: the documented ' +
    'timestamp back-dating pass, since no service accepts historical dates). 6.7.3 asserts ' +
    'the scaled behaviour: builder + saved filters over the corpus run INDEXED (EXPLAIN: no ' +
    'seq-scan at corpus size), the 6.3 widgets and built-in reports (created-vs-resolved, ' +
    'status distribution) aggregate **in SQL** — no response carries the row set (the ' +
    'finding-#57 sentinel for Epic 6) — a **bulk transition sweep fires rules exactly once** ' +
    '(no loss, no duplicates under job retries), and the **combined a11y sweep** covers the ' +
    'fully-populated 6.5 admin hub + a populated dashboard in light AND dark (the state no ' +
    'per-story sweep renders).\n\n' +
    '**Out of scope:** everything an owning closer already tests (listed in the re-scope ' +
    'note); the key-change × old-URL redirect behaviour (Story 6.8 owns it, including saved ' +
    'filters that reference the old key); the cross-feature COLLABORATION journey (5.6.2 owns ' +
    'it); load/stress tooling beyond the bounded-read + EXPLAIN assertions (the CI-lane cap ' +
    'pattern applies instead).',
  verificationRecipeMd:
    '- Pull the Story branch (requires Stories 6.1–6.6 merged; 6.4 already shipped), `pnpm ' +
    'install`, `pnpm prisma migrate dev` (no migration — test-only story), `pnpm db:seed`, ' +
    '`pnpm dev`.\n' +
    '- `pnpm db:seed:reporting` (6.7.1) → the corpus exists: 10k issues (CI cap reduced) ' +
    'spread over ~26 weeks of created/resolved dates with full field spread, 5+ named saved ' +
    'filters, a dashboard whose widgets consume them, 3+ enabled automation rules — seeded ' +
    'through the shipped services, deterministic across reseeds, self-check green (incl. the ' +
    'documented timestamp pass).\n' +
    '- `pnpm test:e2e --grep epic6-journey` — the combined journey passes: build → save → ' +
    'widget → rule → transition → fire (History attributed to automation, ONE deduped watcher ' +
    'email, widget count tracks), the non-admin gate (UI hidden + API 403 on every Epic-6 ' +
    'admin surface), and the unwind (filter delete → stale widget state; rule disable → ' +
    'silence; rule delete → fallback-rendering History).\n' +
    '- `pnpm test:e2e --grep epic6-at-scale` — over the corpus: filter + saved-filter ' +
    'application paginates with count (no full-set response — network census), widgets and ' +
    'reports render from SQL aggregates, the bulk-transition sweep fires exactly N rules, and ' +
    'the combined admin-hub + dashboard strict axe sweep reports zero violations in both ' +
    'themes; the CI lane runs at the reduced cap.\n' +
    '- `pnpm test` — the role × Epic-6-admin-endpoint matrix (driven from the route ' +
    'inventory) and the exactly-once firing properties pass at the service layer; ' +
    '`pnpm test:coverage` holds the gate; all sibling suites stay green.\n' +
    '- Drift check: the specs assert NO unbounded read exists on the reporting path (the ' +
    'finding-#57 sentinel for Epic 6).',
  items: [
    {
      id: '6.7.1',
      title:
        'Reporting-shaped corpus — `db:seed:reporting` time-spread 10k-issue seed + saved filters/dashboard/rules through the shipped services (+ helpers, CI-lane cap)',
      status: 'done',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['6.2', '6.3', '6.6', '5.3.3', '5.4.2'],
      descriptionMd:
        'The fixture gap (the 4.7.1 / 5.6.1 precedent): no existing large seed builds ' +
        'reporting-shaped data. A `scripts/seed-reporting.ts` (+ `pnpm db:seed:reporting`) ' +
        'constructing the **corpus** through the shipped services (the no-raw-inserts rule, ' +
        'doubling as a bulk smoke test of every Epic-6 write path), with ONE recorded ' +
        'deviation: a documented **timestamp back-dating pass** (created/resolved/revision ' +
        'timestamps are server-set and no service accepts them; the pass is confined to this ' +
        'script, touches timestamps only, and the self-check asserts the resulting spread).\n\n' +
        '**The corpus:** 10k issues (cap-parameterised env var; the CI lane runs reduced — ' +
        'the board-at-scale cap precedent) spread across ~26 weeks of created/resolved ' +
        'history with realistic weekly variance (the created-vs-resolved report needs real ' +
        'buckets), full spread over status/priority/assignee/kind, label + component + all ' +
        'five custom-field types valued on meaningful subsets (the 6.1 predicates need ' +
        'selective matches, not all-or-nothing), a long-tail of resolved issues for the ' +
        'status-distribution report. **Plus the Epic-6 entities:** 5+ named saved filters ' +
        '(6.2) spanning enum/negation/date-window/CF predicates, one populated dashboard ' +
        '(6.3) whose widgets consume them, and 3+ enabled automation rules (6.6) over the ' +
        'built-in action set. **Deterministic** (the FNV-hash convention — no ' +
        'Date.now/random; stable across reseeds). Fixture **helpers** ' +
        '(`tests/e2e/_helpers/reporting.ts`): accessors for the corpus counts AND the ' +
        '**expected aggregates** (weekly created-vs-resolved buckets, the status ' +
        'distribution) computed independently from the deterministic spread — the values ' +
        'the 6.7.3 report asserts compare against.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed:reporting` builds the corpus + saved filters + dashboard + rules ' +
        'idempotently through the shipped services (re-run converges; any service error ' +
        'fails loudly), deterministic, cap-parameterised with the CI lane reduced.\n' +
        '- The seeded shape matches the spec sheet (time spread with weekly variance, field ' +
        'spread, selective predicate matches, the Epic-6 entities) — asserted by a fixture ' +
        'self-check, including that the timestamp pass produced the intended distribution.\n' +
        '- The back-dating deviation is documented in the script header (what, why, scope) ' +
        'and touches nothing but timestamps.\n' +
        '- Helpers expose counts + independently-computed expected aggregates; existing ' +
        'seeds and suites untouched and green; `pnpm test:coverage` holds on shared ' +
        'helpers.\n\n' +
        '## Context refs\n\n' +
        '- The fixture lineage: `db:seed:large` (2.5.16), `seedLargeBoard` (3.5.1), the ' +
        '4.7.1 sprint seed, `db:seed:collab` (5.6.1) — the cap/CI-lane + determinism ' +
        'patterns\n' +
        '- The Epic-6 services as they land (6.2 saved filters, 6.3 dashboards, 6.6 rules) ' +
        '— the only write paths besides the timestamp pass\n' +
        '- 5.3.3 / 5.4.2 (custom-field + label write paths for the predicate spread)\n' +
        '- The no-raw-inserts seed rule (MOTIR.md Plan seed §) + the recorded deviation ' +
        'in the Story 6.7 header',
    },
    {
      id: '6.7.2',
      title:
        'The combined Epic-6 journey E2E — build a filter, save it, back a widget, gate a viewer, fire a rule; the cross-story seams asserted end-to-end',
      status: 'in_progress',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['6.7.1', '6.1.6', '6.2', '6.3', '6.4', '6.5', '6.6'],
      descriptionMd:
        'The chain-proof: `tests/e2e/epic6-journey.spec.ts`, one continuous flow on a ' +
        'fresh small project (not the corpus — this spec is about the seams, not scale), ' +
        'against the standing dev-server harness with the Inngest dev stub.\n\n' +
        '**The build-up (admin):** build an advanced filter with a negation row + a ' +
        'custom-field row (the 6.1 builder) → save + name it (6.2) → back a dashboard ' +
        'widget with the saved filter (6.3) → create an automation rule from the built-in ' +
        'action set (6.6) → transition a matching issue → assert the seams in one pass: ' +
        'the rule fires through the job lane exactly once, its action lands **through the ' +
        'shipped services** (History records it attributed to automation — the 5.5 feed ' +
        'shows it like a real actor; the 5.4 watcher email fires with the dedupe contract ' +
        'intact, actor excluded), and the saved-filter result set + the widget count both ' +
        'track the change.\n\n' +
        '**The gate (non-admin):** in a limited/private project (the shipped 6.4 levels), ' +
        'the viewer uses what the level grants, but EVERY Epic-6 admin surface — ' +
        'saved-filter management, dashboard editing, rule admin in the 6.5 hub — is hidden ' +
        'in the UI AND rejected 403 at the API (deep-link + direct request both). These ' +
        'surfaces post-date 6.4.8, so no shipped test covers them.\n\n' +
        '**The unwind:** delete the saved filter under the live widget → the designed ' +
        'stale-widget state (the 6.1 stale-referent durability rule one story up), never a ' +
        'crash; disable the rule → a further transition fires nothing; delete the rule → ' +
        'its History entries keep rendering via the deleted-referent fallback (the 5.5.1 ' +
        'grammar).\n\n' +
        '**Vitest companion** (`tests/integration/epic6-journey.test.ts`): the ' +
        '**consolidated role × Epic-6-admin-endpoint permission matrix** — driven from a ' +
        'route inventory so a new admin endpoint without a matrix row FAILS the suite (the ' +
        'totality-guard pattern) — plus the rule-firing transaction seams the E2E asserts ' +
        'weakly: exactly-once per event under retry, automation actor attribution on the ' +
        'revision rows, no orphan rows after rule delete.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The E2E passes the full build-up + gate + unwind with every cross-story assert ' +
        "named above, green in CI's Playwright lane (harness + selector memories " +
        'respected).\n' +
        '- The gating asserts are exhaustive over the Epic-6 admin surfaces (UI hidden AND ' +
        'API 403, per surface); the notification assert is exact (one deduped watcher ' +
        'email, zero to the actor).\n' +
        '- The Vitest matrix is inventory-driven (a new admin route without a row fails); ' +
        'the exactly-once + attribution + no-orphan properties hold at the service layer.\n' +
        '- No duplication of per-story coverage (spec-header review note mapping each ' +
        'assert to the seam it owns); flake isolation respected.\n\n' +
        '## Context refs\n\n' +
        '- The owning closers — 6.1.6, 6.4.8, and the 6.2/6.3/6.5/6.6 closers as they land ' +
        '— what NOT to re-test; their specs as harness/selector exemplars\n' +
        '- 6.7.1 helpers; the dev email console `[EMAIL]` grep contract; `@inngest/test` ' +
        "where the E2E can't reach\n" +
        '- The seam contracts: the 6.1 stale-referent rule (6.2 saved filters inherit it), ' +
        'the 5.5.1 deleted-referent fallback, the 5.4 notification dedupe, the 6.4 ' +
        'access-level model\n' +
        '- The E2E harness memories (standing dev server + Inngest stub, OOM-safe); the ' +
        '2.6.1 route-inventory/totality-guard pattern',
    },
    {
      id: '6.7.3',
      title:
        'Search/reporting/automation at scale — indexed filters + SQL-aggregated reports over the corpus, the exactly-once rule storm, and the combined admin a11y sweep',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['6.7.1', '6.1.6', '6.2', '6.3', '6.5', '6.6'],
      descriptionMd:
        'The finding-#57 sentinel for Epic 6: `tests/e2e/epic6-at-scale.spec.ts` (+ a ' +
        'Vitest companion for the query-shape asserts) over the 6.7.1 corpus.\n\n' +
        '**Indexed search:** builder filters and saved filters applied over the 10k corpus ' +
        'return paginated results + count without a full-set response (network census); ' +
        'EXPLAIN spot-checks on the heavy predicates (text contains via trgm, CF joins, ' +
        'date windows) show index scans at corpus size — no seq-scan over `work_item` or ' +
        'the value tables.\n\n' +
        '**SQL-aggregated reporting:** the dashboard widgets and the built-in reports ' +
        '(created-vs-resolved, status distribution) compute their aggregates IN the ' +
        'database — asserted two ways: no API response carries the row set (census), and ' +
        "the rendered numbers equal the 6.7.1 helpers' independently-computed expected " +
        'aggregates (correctness, not just boundedness). Widget render at load completes ' +
        'without timeout at the CI cap.\n\n' +
        '**The rule storm:** a bulk sweep of N transitions over corpus issues matching an ' +
        'enabled rule → exactly N firings (no loss, no duplicates under simulated job ' +
        'retries — `@inngest/test`), bounded job payloads (an event carries ids, never ' +
        'issue bodies), and the actions all land (spot-check the written rows).\n\n' +
        '**The combined a11y sweep:** the fully-populated 6.5 admin hub — members + roles, ' +
        'workflow, custom fields, labels, components, automation rules, all sections at ' +
        'once over the corpus project — AND a populated dashboard pass the strict axe ' +
        'config in light AND dark. No per-story sweep renders this combined state; ' +
        'landmark/heading uniqueness and focus order across the stacked admin sections are ' +
        'exactly the class of bug only the combined page shows.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The network census proves every search/reporting read is paged or aggregated ' +
        '(zero full-set responses over the corpus); the EXPLAIN spot-checks show index ' +
        'scans; the report numbers equal the independently-computed expectations.\n' +
        '- The rule storm fires exactly N times under retry simulation with bounded ' +
        'payloads; the written actions verify.\n' +
        '- The combined admin-hub + dashboard strict axe sweep reports zero violations in ' +
        'both themes.\n' +
        '- The specs run in the reduced-cap CI lane (the board-at-scale precedent) and ' +
        'full-size locally; green in CI; the spec header documents the census as the ' +
        'Epic-6 finding-#57 sentinel (future Epic-6-touching PRs inherit the regression ' +
        'net).\n\n' +
        '## Context refs\n\n' +
        '- 6.7.1 fixture + helpers (the counts + expected aggregates)\n' +
        '- `tests/e2e/board-at-scale.spec.ts` (3.5), the 4.7 at-scale specs, 5.6.3 — the ' +
        'census/DOM-budget assertion style + CI-lane pattern to mirror\n' +
        '- 6.1.1 (the trgm index + parameterized compile path the EXPLAIN checks cover); ' +
        'the 6.2/6.3/6.6 read/aggregate contracts as they land\n' +
        '- The strict-a11y sweep configs (2.4.6 lineage); findings #35/#57',
    },
  ],
};
