# The acceptance lane — per-spec disposition

**What this is.** One row per `tests/e2e/acceptance*.spec.ts`, with the story it
records, that story's state, the disposition, and — for a retire — where the
flow stays covered. Required by MOTIR-2769: a promote-or-retire decision made
silently is one nobody can audit later, and _"why did this spec disappear"_ is
exactly the question a future reader asks.

**The rule it applies** is `docs/decisions/acceptance-receipt-lifecycle.md` §3:
once a receipt is frozen the spec has discharged its purpose and leaves the
acceptance lane by exactly one of two routes — **PROMOTE** into a lane that runs
on every PR, or **RETIRE** citing its cover. There is no third route and no
"leave it for now"; that was the defect.

**Measured 2026-08-13 on `origin/main` @ `fca2c9f3`: 26 specs. Every one of the
26 declared stories is `done`** — the lane holds no in-flight member at all, so
all 26 owe a disposition.

---

## The environment split that shapes half this table

A promotion is not only a rename. The two lanes' globs are complementary — the
main config `testIgnore`s exactly what the acceptance config `testMatch`es — but
their **servers are not the same product**:

| Lane                              | `MOTIR_CLOUD` | `E2E_TEST_BILLING` | `MOTIR_AI_URL` | `E2E_TEST_CODE_HEALTH` | `E2E_TEST_GITHUB_REPOS` |
| --------------------------------- | ------------- | ------------------ | -------------- | ---------------------- | ----------------------- |
| `playwright.config.ts` (main)     | ✗             | ✗                  | ✗              | ✗                      | ✗                       |
| `playwright.acceptance.config.ts` | ✓             | ✓                  | ✓              | ✓                      | ✓                       |
| `playwright.billing.config.ts`    | ✓             | ✓                  | ✗              | ✗                      | ✗                       |

Nine specs assert behaviour that exists only under those flags. Renaming them
into the main lane would not fail loudly — it would assert a product that, in
that lane, is switched off, and `playwright.acceptance.config.ts`'s own header
records why that goes GREEN rather than red (MOTIR-2601: off-cloud, entitlement
paths short-circuit to the same inert value they return for an exempt org). The
repo already states the main lane's ground truth from the other side:
`ai-callout-gate.spec.ts` asserts that with Motir AI unconfigured **there is no
orb**.

Those nine are promoted into the **cloud-on regression lane** MOTIR-2849 built
for them: `playwright.cloud.config.ts` (the former billing lane, widened rather
than a third lane invented), which they join under the `cloud-` prefix.

---

## RETIRE — the flow is covered by a main-lane twin

Each row names where the coverage lives. None of these deletions removes a
flow's last coverage.

| Spec                                     | Story      | Story state | Coverage stays at                                                                                                                                                                                       |
| ---------------------------------------- | ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-permission-gated-ui.spec.ts` | MOTIR-2258 | `done`      | `permission-gated-ui.spec.ts` — 4 tests (admin keeps the shell · member offered no settings area · viewer loses refused destinations · per-destination refusal). Superset.                              |
| `acceptance-project-logo.spec.ts`        | MOTIR-2588 | `done`      | `project-logo.spec.ts` — 5 tests (upload → header → remove → empty state · switcher alignment · org tier carries no mark · rejects non-image and over-ceiling). Superset.                               |
| `acceptance-quick-view-edit.spec.ts`     | MOTIR-2560 | `done`      | `quick-view-edit.spec.ts` — 4 tests (every field kind + reload · the same rail from /boards and the roadmap · viewer gets no affordance · a refused edit reverts). Superset.                            |
| `acceptance-shell-context-path.spec.ts`  | MOTIR-2554 | `done`      | `shell-context-path.spec.ts` — 6 tests (every band, both absences, the 320px overflow). **The acceptance file's own header says so:** _"The functional assertions … are `shell-context-path.spec.ts`."_ |
| `acceptance-tokens-rename.spec.ts`       | MOTIR-2532 | `done`      | `api-tokens.spec.ts` — _"the account rail says Tokens, and the row opens the pane"_ and _"the OLD address still lands on the pane"_, which is the rename story's whole claim.                           |

> `acceptance-shell-context-path.spec.ts` additionally declares **no**
> `acceptanceStory()` at all — it names MOTIR-2554 only in a header comment, so
> its clip has been publishing against the uploader's PR-ref fallback rather
> than to that story. It is in the wrong lane for two independent reasons.

## PROMOTE — into the MAIN lane (env-compatible)

No cloud, AI, code-health or GitHub-provisioning seam; the main lane's server
can run these as they stand. Promotion = rename out of the `acceptance*` prefix,
swap the `test` import from `_helpers/acceptance-video` to the main fixture,
strip `chapter()` / `beat()` / `acceptanceStory()` and the pacing holds, keep
every assertion.

| Spec                                           | Story      | Why not a retire — what would be lost                                                                                                     |
| ---------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-api-docs.spec.ts`                  | MOTIR-1854 | 10 tests over the docs area (reference, sandbox guide, phone widths, catalogue filter, every legacy address, the CLI guide). No twin.     |
| `acceptance-child-panel-graph.spec.ts`         | MOTIR-2284 | The Children panel's list ↔ graph. `canvas-detail.spec.ts` drives the ROADMAP canvas, a different surface. No twin.                       |
| `acceptance-cli-connect.spec.ts`               | MOTIR-1863 | The device-code connect journey incl. signed-out arrival, deny, expired/unknown codes. No e2e twin.                                       |
| `acceptance-custom-roles.spec.ts`              | MOTIR-2257 | Authoring a role, assigning it, deleting with reassign. The permission specs assert built-in roles, not authoring. No twin.               |
| `acceptance-design-result.spec.ts`             | MOTIR-2664 | Publish-from-CI and the unsigned-read refusal. No twin.                                                                                   |
| `acceptance-docs-index.spec.ts`                | MOTIR-2315 | The `/docs` index as a front door. No twin.                                                                                               |
| `acceptance-mcp-docs.spec.ts`                  | MOTIR-2309 | The MCP page reachable and complete for an anonymous reader. No twin.                                                                     |
| `acceptance-onboarding-migrate.spec.ts`        | MOTIR-815  | The migrate wizard end to end (6 tests). `migrate-index-fleet.spec.ts` covers only the Index step; `import.spec.ts` only the importer.    |
| `acceptance-roadmap-auto-drill.spec.ts`        | MOTIR-1803 | Auto-drill. The four `roadmap-*.spec.ts` cover scope, locate, done/ready and the basic drill — none covers auto-descent.                  |
| `acceptance-roles-permissions.spec.ts`         | MOTIR-2282 | The roles SCREENS (list, drill-in, refusal on both routes, axe-clean). The permission specs assert behaviour, not these screens. No twin. |
| `acceptance-token-permissions.spec.ts`         | MOTIR-2572 | `api-tokens.spec.ts` covers minting and displayed scopes; only this asserts a real write **refused by name**. Enforcement is uncovered.   |
| `acceptance-work-item-type-vocabulary.spec.ts` | MOTIR-2622 | `work-item-type.spec.ts` covers typed create / chips / filter; only this asserts the fourteen-member vocabulary in both pickers.          |

## PROMOTE — into the CLOUD-ON lane (MOTIR-2849)

Renamed `acceptance-<name>.spec.ts` → `cloud-<name>.spec.ts`, which moves them out
of the acceptance lane's glob and into `playwright.cloud.config.ts`'s. That lane
now boots a PRODUCTION build and carries every seam they drive — billing, the
motir-ai boundary mock, the code-health fixture and the GitHub provisioning mock.

| Spec                                     | Story      | Seam the main lane lacks                                              |
| ---------------------------------------- | ---------- | --------------------------------------------------------------------- |
| `cloud-video.spec.ts`                    | MOTIR-1627 | billing — 7 plan/toggle/pending/upgrade gate states + the board badge |
| `cloud-ai-callout.spec.ts`               | MOTIR-1342 | motir-ai + billing — the main lane provably has no orb                |
| `cloud-augment-replan.spec.ts`           | MOTIR-811  | motir-ai + billing                                                    |
| `cloud-contextual-plan-confirm.spec.ts`  | MOTIR-812  | motir-ai + billing                                                    |
| `cloud-plan-change-conversation.spec.ts` | MOTIR-1726 | motir-ai + billing                                                    |
| `cloud-cadence.spec.ts`                  | MOTIR-813  | motir-ai                                                              |
| `cloud-audit-coverage.spec.ts`           | MOTIR-2244 | code-health fixture + motir-ai                                        |
| `cloud-org-settings-truth.spec.ts`       | MOTIR-2542 | billing — the "no upgrade this org needs" assertion                   |
| `cloud-repository-set.spec.ts`           | MOTIR-1775 | the GitHub provisioning mock (9 tests, 783 lines)                     |

> **The `acceptance-ai-callout` row corrects MOTIR-2765's worked example.** The
> story cites it as the model retire, on the grounds that `ai-callout-gate.spec.ts`
> "already rides the main lane asserting the same shell behaviour". Read: the twin
> asserts the NEGATIVE — _"with Motir AI not configured there is no orb and no
> callout."_ The acceptance spec asserts the POSITIVE — the orb opens and Plan
> with AI reaches the workspace. Retiring it would delete the only coverage of
> the configured path, so it is a promote, into a lane that can configure it.

---

## In-flight members added since the 2026-08-13 measurement

The count above was taken when the lane held no in-flight member. A story still
in review legitimately sits in the lane while its receipt is being accepted, and
owes its disposition at the moment it freezes — the rule is the same one, applied
on time rather than retroactively.

| Spec                                       | Story      | State                 | Disposition when the receipt freezes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-repository-reference.spec.ts`  | MOTIR-2732 | in review             | **PROMOTE → main lane.** Nothing it asserts needs a cloud-on flag: repository ROWS, a link with a destination, a `repository`/`transferred` delivery through the real webhook, and the two-repository hold are all plain product behaviour. The rename step in particular is a REGRESSION test in a way a receipt is not — a reference that stops surviving a rename is the whole story failing silently, and it belongs on every pull request rather than in a clip nobody re-runs. Promote alongside `acceptance-repository-set.spec.ts` (MOTIR-2725), whose flow it extends rather than duplicates: that one proves the SET holds a card open, this one proves the set's elements are objects. |
| `acceptance-scoped-run.spec.ts`            | MOTIR-3001 | in review             | **PROMOTE → main lane.** Same reason as the row below, and it inherits that row's machinery: the v1 ready read, the scope claim, the signed deliveries and the board are all plain product behaviour with no cloud-on flag anywhere in them. It is here for the RECEIPT — the story's whole visible change is a WHOLE STORY going In Progress at once, which is a thing to watch rather than to read. When it freezes, the six off-camera tests are the ones worth every PR: the claim's refusals (`taken`, `wrong_shape`, `not_finishable`) and the 422 on an unresolvable scope value are each a silent failure otherwise — a filter that quietly widened is how a run claims a project.        |
| `acceptance-implemented-lifecycle.spec.ts` | MOTIR-2999 | in review             | **PROMOTE → main lane.** Nothing it asserts needs a cloud-on flag: signed `pull_request` and `check_suite` deliveries through the real webhook, the CI-green promotion, the session close-out and the board are plain product behaviour, and the main lane's server runs all of them. It is in the acceptance lane for the RECEIPT, not for the environment — the story's whole visible change is a card moving on its own, which is a thing to watch rather than to read. When it freezes, the failing-build beat in particular becomes a regression test worth every PR: a promotion that fires on a red build is silent, and this is what would catch it.                                      |
| `acceptance-repository-set.spec.ts`        | MOTIR-2725 | **PROMOTED — landed** | Done, by MOTIR-3009 → now `repository-set.spec.ts` in the main lane. The disposition is the one the row above already named ("promote alongside"); MOTIR-2999 is what made it DUE, because it changed the lifecycle the spec walks. The ordering matters and is the rule, not a convenience: a frozen receipt must not be edited to describe today, so the spec left the lane first and its status assertion was updated afterwards, as a regression test. Every assertion survived the move — the `_helpers/promoted-regression` import swap is what guarantees that.                                                                                                                            |

---

## Standing count

|                                                  |       |
| ------------------------------------------------ | ----- |
| In the lane at `fca2c9f3`                        | 26    |
| Retire                                           | 5     |
| Promote → main lane                              | 12    |
| Promote → cloud-on lane (MOTIR-2849)             | 9     |
| Left undecided                                   | **0** |
| In-flight stories still legitimately in the lane | 2     |
| …of which promoted since (MOTIR-3009)            | 1     |

When every row has landed, the acceptance lane's membership is exactly the
stories currently in review — verifiable by listing the directory.

---

## MOTIR-4094 drain — 2026-09-01

All 23 specs present at the start of MOTIR-4094 declared a story whose work item
is now `done`; none remains an in-flight receipt. The disposition of every
starting member is recorded below.

| Starting spec                               | Story      | Disposition                                                                                                                                                                                          |
| ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance-agent-authored-plan.spec.ts`    | MOTIR-2982 | **PROMOTE → main** as `agent-authored-plan.spec.ts`.                                                                                                                                                 |
| `acceptance-agent-runs.spec.ts`             | MOTIR-1789 | **PROMOTE → cloud** as `cloud-agent-runs.spec.ts`; the unchanged receipt assertions require the acceptance-compatible runner.                                                                        |
| `acceptance-ask-about-this-project.spec.ts` | MOTIR-1343 | **PROMOTE → cloud** as `cloud-ask-about-this-project.spec.ts`; it requires the motir-ai jobs seam.                                                                                                   |
| `acceptance-delivery-set.spec.ts`           | MOTIR-3655 | **PROMOTE → main** as `delivery-set.spec.ts`.                                                                                                                                                        |
| `acceptance-design-result-publish.spec.ts`  | MOTIR-3780 | **PROMOTE → main** as `design-result-publish.spec.ts`; unlike `design-result.spec.ts`, it protects the publish half.                                                                                 |
| `acceptance-general-attachment.spec.ts`     | MOTIR-3000 | **PROMOTE → main** as `general-attachment.spec.ts`.                                                                                                                                                  |
| `acceptance-implemented-lifecycle.spec.ts`  | MOTIR-2999 | **PROMOTE → main** as `implemented-lifecycle.spec.ts`, matching its earlier recorded disposition.                                                                                                    |
| `acceptance-navigation-instant.spec.ts`     | MOTIR-3430 | **PROMOTE → main** as `navigation-instant.spec.ts`.                                                                                                                                                  |
| `acceptance-pages-stream.spec.ts`           | MOTIR-3440 | **PROMOTE → main** as `pages-stream.spec.ts`.                                                                                                                                                        |
| `acceptance-passkeys.spec.ts`               | MOTIR-1214 | **RETIRE**; the broader machine-speed coverage is `passkeys.spec.ts`.                                                                                                                                |
| `acceptance-plan-detail-refined.spec.ts`    | MOTIR-4016 | **PROMOTE → main** as `plan-detail-refined.spec.ts`.                                                                                                                                                 |
| `acceptance-plan-revision.spec.ts`          | MOTIR-3595 | **PROMOTE → cloud** as `cloud-plan-revision.spec.ts`; it requires the motir-ai jobs seam.                                                                                                            |
| `acceptance-plan-shapes.spec.ts`            | MOTIR-3232 | **PROMOTE → main** as `plan-shapes.spec.ts`.                                                                                                                                                         |
| `acceptance-plan-timeline.spec.ts`          | MOTIR-3532 | **PROMOTE → main** as `plan-timeline.spec.ts`.                                                                                                                                                       |
| `acceptance-plans-surface.spec.ts`          | MOTIR-3232 | **PROMOTE → cloud** as `cloud-plans-surface.spec.ts`; it protects the list half, distinct from plan shapes, and its approval seed requires the Node test-runner mapping carried by the cloud config. |
| `acceptance-public-cloud-gate.spec.ts`      | MOTIR-3908 | **PROMOTE → cloud** as `cloud-public-cloud-gate.spec.ts`; its positive arm requires `MOTIR_CLOUD`.                                                                                                   |
| `acceptance-public-redirect.spec.ts`        | MOTIR-3932 | **PROMOTE → cloud** as `cloud-public-redirect.spec.ts`; it requires a distinct public-site origin.                                                                                                   |
| `acceptance-repository-reference.spec.ts`   | MOTIR-2732 | **PROMOTE → main** as `repository-reference.spec.ts`, matching its earlier recorded disposition.                                                                                                     |
| `acceptance-roadmap-arrival.spec.ts`        | MOTIR-3833 | **PROMOTE → cloud** as `cloud-roadmap-arrival.spec.ts`; the unchanged viewport assertions require the acceptance-compatible runner.                                                                  |
| `acceptance-run-findings.spec.ts`           | MOTIR-3017 | **PROMOTE → cloud** as `cloud-run-findings.spec.ts`; its plan submission requires motir-ai.                                                                                                          |
| `acceptance-scoped-run.spec.ts`             | MOTIR-3001 | **PROMOTE → main** as `scoped-run.spec.ts`, matching its earlier recorded disposition.                                                                                                               |
| `acceptance-two-factor-enforcement.spec.ts` | MOTIR-1215 | **RETIRE**; the broader machine-speed coverage is `two-factor-enforcement.spec.ts`.                                                                                                                  |
| `acceptance-work-item-todo-list.spec.ts`    | MOTIR-3808 | **PROMOTE → main** as `work-item-todo-list.spec.ts`.                                                                                                                                                 |

Standing membership after this drain: **0 acceptance specs**. New in-review
receipts may enter the lane and must leave again when approved.
