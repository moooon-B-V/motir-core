import type { PlanStory } from '../types';

/**
 * Story 5.6 — Tests: the combined collaboration journey + the loaded issue at
 * scale.
 *
 * Re-scope note (deepening, 2026-06-10 — the Story 3.5 / 4.7 precedent,
 * applied verbatim). The stub framed 5.6 as "Vitest over comment/field/
 * activity services; Playwright over comment+mention, attach a file, set a
 * custom field, read the activity feed" — written when 5.6 was the ONLY
 * Epic-5 test story. Since then EVERY Epic-5 story grew its own closing test
 * subtask owning the per-method Vitest + the focused single-surface E2E:
 * **5.1.7** (comments/mentions incl. the comment→mention→email journey),
 * **5.2.8** (attachments incl. upload→panel→preview→delete + the
 * editor-sourced block), **5.3.8** (custom fields incl. define→set→history→
 * delete), **5.4.11** (labels/components/watchers incl. the notification
 * dedupe matrix), **5.5.5** (activity incl. the registry-totality guard +
 * the All-merge properties). So 5.6 is scoped to the NON-duplicative
 * remainder — the two things no single story owns:
 *
 *   1. **The combined cross-feature journey** — every Epic-5 feature
 *      exercised on ONE issue in one flow, asserting the CROSS-feature seams
 *      end-to-end (a single comment that embeds a file, @mentions a watcher,
 *      and lands in the activity feed touches FIVE stories' code in one
 *      transaction chain; each story's tests prove its own link, none proves
 *      the chain).
 *   2. **The collaboration-loaded issue at scale** — the detail page with
 *      hundreds of comments/attachments/revisions + full rail + many
 *      watchers stays bounded (finding #57) and accessible. The existing
 *      large fixtures are tree-shaped (2.5.16), board-shaped (3.5.1), and
 *      sprint-shaped (4.7.1) — NONE builds collaboration data, the same
 *      fixture gap 4.7.1 closed for Scrum (hence 5.6.1).
 *
 * It does NOT re-test what an owning story covers in isolation (the comment
 * permission matrix is 5.1.7's; the blob lifecycle is 5.2.8's; the per-type
 * field validation is 5.3.8's; the folksonomy + notification-dedupe units are
 * 5.4.11's; the renderer totality is 5.5.5's).
 *
 * 📦 Lives in Epic 5; every dep is an Epic-5 sibling (backward — the audit is
 * clean). All subtasks seed `'blocked'`: the journey needs every feature
 * built, and the fixture needs every service to seed through (the
 * no-raw-inserts seed rule).
 *
 * Expanded from its `stubs.ts` entry per `prodect plan 5.6`, on the standing
 * `seed/epic-5-plan` branch. Matches the canonical style of 4.7 / 5.1–5.5.
 */
export const story_5_6: PlanStory = {
  id: '5.6',
  title: 'Tests — the combined collaboration journey + the loaded issue at scale',
  status: 'planned',
  descriptionMd:
    'The Epic-5 cross-cutting test story, re-scoped (the 3.5/4.7 precedent) to the ' +
    'non-duplicative remainder now that every sibling story carries its own closing test ' +
    'subtask (5.1.7 / 5.2.8 / 5.3.8 / 5.4.11 / 5.5.5). Two deliverables:\n\n' +
    '**1. The combined collaboration journey (5.6.2).** One issue, every Epic-5 feature, one ' +
    'flow — asserting the seams that only exist BETWEEN stories: a comment that **embeds an ' +
    'upload** (5.2.3 links it, panel shows it editor-sourced), **@mentions a user who is also ' +
    'watching** (exactly ONE email — the mention; the watcher job dedupes), on an issue with ' +
    '**custom-field values, labels, components**, while a second user **watches** and the ' +
    '**activity feed** interleaves all of it in order; then the unwind — delete the comment ' +
    '(thread cascades, the embedded attachment unlinks, History records the deletion, no ' +
    'stale notification fires), delete the custom field (values vanish, old History entries ' +
    'render the fallback), archive a select option (old values + History keep rendering). ' +
    'Each story proves its own link; THIS spec proves the chain.\n\n' +
    '**2. The collaboration-loaded issue at scale (5.6.1 fixture + 5.6.3 specs).** A real ' +
    "team's oldest issue is heavy: hundreds of comments and revisions, dozens of attachments, " +
    'a full rail, many watchers. The existing large fixtures (tree-shaped 2.5.16, board-shaped ' +
    '3.5.1, sprint-shaped 4.7.1) build NONE of that — the same fixture gap 4.7.1 closed for ' +
    'Scrum. 5.6.1 builds the collaboration-heavy seed **through the shipped services** (the ' +
    'no-raw-inserts rule, which doubles as a bulk-path smoke test); 5.6.3 asserts the loaded ' +
    'detail page stays **bounded** (every collection paged — comments, attachments, history, ' +
    'watchers; the rail capped by the 50-field rule; one batched resolution set per page; ' +
    'bounded DOM) and **accessible** (the strict axe sweep over the fully-populated page — ' +
    'every Epic-5 surface at once, the state no per-story sweep renders).\n\n' +
    '**Out of scope:** everything an owning story already tests (listed in the re-scope ' +
    'note); cross-ISSUE collaboration views (Epic-6 reporting); load/stress testing beyond ' +
    'the bounded-read assertions (no perf-lab tooling in the repo — the CI-lane cap pattern ' +
    'from board-at-scale applies instead).',
  verificationRecipeMd:
    '- Pull the Story branch (requires Stories 5.1–5.5 merged), `pnpm install`, `pnpm prisma ' +
    'migrate dev` (no migration — test-only story), `pnpm db:seed`, `pnpm dev`.\n' +
    '- `pnpm db:seed:collab` (5.6.1) → the loaded issue exists: 300+ comments (threaded, ' +
    'mention-bearing), 60+ attachments (mixed panel/editor-sourced), all five custom-field ' +
    'types valued, 10+ labels, 3+ components, 15+ watchers, 500+ revisions — all seeded ' +
    'through the shipped services (the script fails loudly on any service error).\n' +
    '- `pnpm test:e2e --grep collab-journey` — the combined journey passes: the ' +
    'comment-with-embed-and-mention chain (ONE email to the mentioned watcher, the ' +
    'attachment auto-linked + editor-sourced, the activity interleave), and the unwind ' +
    '(comment delete → cascade + unlink + History record; field delete → fallback entries; ' +
    'option archive → still-rendering history).\n' +
    "- `pnpm test:e2e --grep collab-at-scale` — the loaded issue's detail page: first paint " +
    'shows one page of each collection with Show-more affordances (network asserts bounded ' +
    'reads — no request returns the full set), the rail renders within the field cap, the ' +
    'strict axe sweep over the fully-populated page reports zero violations, and the CI lane ' +
    'runs at the reduced cap (the board-at-scale lane precedent).\n' +
    '- `pnpm test:coverage` — the journey/fixture helpers hold the coverage gate; all ' +
    'sibling-story suites still green (no regression from the fixture).\n' +
    '- Drift check: the spec asserts NO unbounded read exists on the detail route (the ' +
    'finding-#57 sentinel for Epic 5).',
  items: [
    {
      id: '5.6.1',
      title:
        'Collaboration-heavy fixture — `db:seed:collab` loaded-issue seed through the shipped services (+ helpers, CI-lane cap)',
      status: 'blocked',
      type: 'code',
      executor: 'coding_agent',
      estimateMinutes: 28,
      dependsOn: ['5.1.2', '5.2.2', '5.2.3', '5.3.3', '5.4.2', '5.4.3', '5.4.4'],
      descriptionMd:
        'The fixture gap (the 4.7.1 precedent): no existing large seed builds collaboration ' +
        'data. A `scripts/seed-collab.ts` (+ `pnpm db:seed:collab`) constructing the **loaded ' +
        'issue** — and a small spread of normally-loaded ones — **through the shipped ' +
        'services only** (the seed rule: no raw inserts; this doubles as a bulk smoke test of ' +
        'every Epic-5 write path).\n\n' +
        '**The loaded issue:** 300+ comments (threads with replies, a realistic ' +
        'mention/author spread across the seed team, deterministic content), 60+ attachments ' +
        '(mixed `panel`/`editor` sources — the editor ones genuinely referenced from ' +
        'bodies so link-on-write produces them), all five custom-field types valued (incl. ' +
        'an archived-option value), 10+ labels, 3+ components (one with a default ' +
        'assignee), 15+ watchers, and 500+ revisions accumulated from real edits ' +
        '(title/status/assignee/field churn — NOT synthetic rows). **Deterministic** (the ' +
        'FNV-hash convention — no Date.now/random seeds; stable across reseeds) and ' +
        '**parameterised by a cap** so the CI lane runs reduced (the board-at-scale ' +
        'cap-40 precedent) while local runs go full-size. Fixture **helpers** ' +
        '(`tests/e2e/_helpers/collab.ts`): accessors for the loaded issue + the known ' +
        'mention/watcher/attachment counts the specs assert against.\n\n' +
        '**Valid-data discipline:** blob uploads use small real fixture files (the 5.2.8 ' +
        'convention); fractional positions stay valid index keys (the board-seed lesson); ' +
        'comment timestamps spread over a realistic range so paging/interleave specs have ' +
        'real boundaries.\n\n' +
        '## Acceptance criteria\n\n' +
        '- `pnpm db:seed:collab` builds the loaded issue + spread idempotently through the ' +
        'shipped services (re-run converges; any service error fails the script loudly), ' +
        'deterministic across runs, cap-parameterised (env var) with the CI lane reduced.\n' +
        '- The seeded shape matches the spec sheet above (counts, mixed sources, threads, ' +
        'archived-option value, default-assignee component) — asserted by a fixture ' +
        'self-check at the end of the script.\n' +
        '- Helpers expose the loaded issue + expected counts; existing seeds and suites ' +
        'are untouched and green.\n' +
        '- `pnpm test:coverage` holds on any new shared helpers.\n\n' +
        '## Context refs\n\n' +
        '- `scripts/` seed conventions: `db:seed:large` (2.5.16), `seedLargeBoard` (3.5.1), ' +
        'the 4.7.1 sprint-shaped seed — the fixture lineage + the cap/CI-lane pattern\n' +
        '- The Epic-5 services (5.1.2 / 5.2.2 / 5.2.3 / 5.3.3 / 5.4.2-4) — the only write ' +
        'paths the seed may use\n' +
        '- The board-E2E memories (valid fractional keys; CI lane cap=40) + the ' +
        'no-raw-inserts seed rule (PRODECT.md Plan seed §)\n' +
        '- `tests/e2e/_helpers/` conventions',
    },
    {
      id: '5.6.2',
      title:
        'The combined collaboration journey E2E — one issue through every Epic-5 feature, the cross-story seams asserted end-to-end',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 35,
      dependsOn: ['5.6.1', '5.1.7', '5.2.8', '5.3.8', '5.4.11', '5.5.5'],
      descriptionMd:
        'The chain-proof: `tests/e2e/collab-journey.spec.ts`, one continuous flow on a fresh ' +
        'issue (not the loaded fixture — this spec is about correctness of the seams, not ' +
        'scale), against the standing dev-server harness with the Inngest dev stub.\n\n' +
        '**The build-up:** create an issue (auto-watch asserted) → second user watches → set ' +
        'custom-field values + labels + components on the rail → post a comment that BOTH ' +
        '**embeds an upload** AND **@mentions the watching user** → assert the seams in one ' +
        'pass: the attachment panel shows the file **editor-sourced** (5.2.3 ran inside ' +
        "5.1.2's tx chain), the mentioned watcher received **exactly ONE email** (the " +
        "mention; the watcher job deduped — grep the dev console for both jobs' output), " +
        'the author received none, a third watching user received the watcher email, and ' +
        'the **All feed** interleaves the field changes, the label/component entries, and ' +
        'the comment in true order with the History tab showing the non-comment entries.\n\n' +
        '**The unwind:** delete the comment (thread + reply cascade) → the embedded ' +
        'attachment **unlinks** from the panel, History records the **deletion** (who/when, ' +
        'no content), and no further notification fires; delete a valued custom field → the ' +
        'rail card vanishes and the old History entries render the **deleted-referent ' +
        'fallback**; archive the select option in use → the rail value and its History ' +
        'entries keep rendering with the archived mark. Transition the issue → the watcher ' +
        'transition email fires (actor excluded).\n\n' +
        '**Vitest companion** (`tests/integration/collab-journey.test.ts`): the same chain ' +
        'at the service layer where E2E assertion is weak — the comment-delete transaction ' +
        'leaves NO orphan mention rows / attachment links / revision gaps (DB-state ' +
        'asserts), and the notification events carry the exact recipient sets the dedupe ' +
        'contract promises.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The E2E passes the full build-up + unwind with every cross-story assert named ' +
        "above, green in CI's Playwright lane (selector + harness memories respected).\n" +
        '- The notification asserts are exact (one mention email, one watcher email to the ' +
        'non-mentioned watcher, zero to the actor; zero after the unwind) — not ' +
        'substring-loose.\n' +
        '- The Vitest companion proves the no-orphan transaction properties + the ' +
        'recipient-set contracts at the service layer.\n' +
        '- No duplication of per-story coverage (review note in the spec header mapping ' +
        'each assert to the seam it owns); flake-isolation respected.\n\n' +
        '## Context refs\n\n' +
        '- The five story test subtasks (5.1.7 / 5.2.8 / 5.3.8 / 5.4.11 / 5.5.5) — what ' +
        'NOT to re-test; their specs as harness/selector exemplars\n' +
        '- 5.6.1 helpers; the dev email console `[EMAIL]` grep contract; `@inngest/test` ' +
        "where the E2E can't reach\n" +
        '- The cross-story seam contracts: 5.2.3 (link-on-write in comment txs), 5.4.5 ' +
        '(mention dedupe), 5.5.1 (fallback rendering)\n' +
        '- The E2E harness memories (standing dev server + Inngest stub, OOM-safe)',
    },
    {
      id: '5.6.3',
      title:
        'The loaded issue at scale — bounded-read + bounded-DOM specs and the full-page strict a11y sweep over every Epic-5 surface at once',
      status: 'blocked',
      type: 'test',
      executor: 'coding_agent',
      estimateMinutes: 30,
      dependsOn: ['5.6.1', '5.1.7', '5.2.8', '5.3.8', '5.4.11', '5.5.5'],
      descriptionMd:
        'The finding-#57 sentinel for Epic 5: `tests/e2e/collab-at-scale.spec.ts` over the ' +
        '5.6.1 loaded issue.\n\n' +
        "**Bounded reads:** opening the loaded issue's detail page issues only PAGED " +
        'requests — comments (one page + Show more), attachments (one page + Show more), ' +
        'History/All (one page each, the composite cursor on All), watchers (count + paged ' +
        'list on popover open) — asserted at the network layer (no response carries the ' +
        'full collection; request census against the helper counts). The rail renders ' +
        'within the 50-field cap with "Show more fields" for the empties. **Bounded DOM:** ' +
        'the first-paint node count stays within a budget derived from the page sizes (the ' +
        'board-at-scale assertion style), and extending one page appends exactly one ' +
        "page's worth. **Interaction at load:** Show-more on each collection, the sort " +
        'toggle, a tab switch, and one comment post on the loaded issue all complete ' +
        'without timeout at the CI cap (the smoke that catches accidental ' +
        'load-all-then-filter regressions).\n\n' +
        '**The full-page strict a11y sweep:** the loaded detail page with EVERY Epic-5 ' +
        'surface populated simultaneously — comments thread + attachments panel + full ' +
        'rail (custom fields, labels, components) + watch control + activity tabs — passes ' +
        'the strict axe config in light AND dark. No per-story sweep renders this ' +
        'combined state; landmark/heading uniqueness and focus order across the stacked ' +
        'sections are exactly the class of bug only the combined page shows.\n\n' +
        '## Acceptance criteria\n\n' +
        '- The network census proves every collection read is paged on the loaded issue ' +
        '(zero full-set responses); the DOM budget + append-exactly-one-page asserts ' +
        'hold; the interaction smoke passes at the CI cap.\n' +
        '- The combined-page strict axe sweep reports zero violations in both themes.\n' +
        '- The spec runs in the reduced-cap CI lane (the board-at-scale lane precedent) ' +
        'and full-size locally; green in CI.\n' +
        '- The spec header documents the bounded-read census as the Epic-5 finding-#57 ' +
        'sentinel (future Epic-5-touching PRs inherit it as the regression net).\n\n' +
        '## Context refs\n\n' +
        '- 5.6.1 fixture + helpers (the counts the census asserts against)\n' +
        '- `tests/e2e/board-at-scale.spec.ts` (3.5) + the 4.7 at-scale specs — the ' +
        'assertion style + CI-lane pattern to mirror\n' +
        '- The per-story paging contracts (5.1.2 comments, 5.2.2 attachments, 5.5.1/2 ' +
        'activity, 5.4.4 watchers, 5.3.3 rail cap)\n' +
        '- The strict-a11y sweep configs (2.4.6 lineage); findings #35/#57',
    },
  ],
};
