# Code context — design notes

**Story [MOTIR-1754] · design subtask [MOTIR-1764]. Repo `motir-core`.**
Asset set: `design/code-context/design-notes.md` + `code-context.mock.html` + `code-context.png`

- `code-context.dark.png`.

The story's user-facing half is one idea in three states: **does Motir know your code, and how current
is what it knows?** This asset draws that on the two surfaces an established project actually reaches
— `/code-health` (the durable **connect** affordance) and `/planning` (where the consequence is felt)
— plus the explicit state for a plan being made with no code at all.

It gates [MOTIR-1768], the renderer. Every behaviour it depicts is specified by a sibling, named per
element in §7; the designer **grounds** the flow in those cards and does not invent it.

---

## 1. What this asset does NOT cover, so no one draws it twice

| out of scope                                                                       | owner                                    | why it is not here                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **consent gate** — the question a planning session asks before proceeding      | [MOTIR-4601]                             | It is a conversational `ask_user` inside the session, rendered by the **shipped** `ask_user` presentation. It needs no new asset, and a second, visual copy of that question drawn here would be a design of a UI the product does not have. |
| The **auto-plan condition text** under the settings row                            | [MOTIR-4603]                             | A copy line under a shipped settings row, not a new surface.                                                                                                                                                                                 |
| **Any commercial cause** — a credit balance, an allowance, a quota, a spent budget | [MOTIR-4541]                             | No panel shows one. The surfaces state the **consequence** and the **remedy**; _why_ indexing paused in cost terms lives in the platform-admin panel, which is not this surface.                                                             |
| **Restoring a provider's ability to be indexed**                                   | [MOTIR-4609], under epic [MOTIR-4608]    | This asset only makes the resulting state speak truthfully — before and after that lands. Panel D3 is that rendering.                                                                                                                        |
| The drift number **told to the planner** rather than to the user                   | [MOTIR-4590]                             | Same number, different audience.                                                                                                                                                                                                             |
| Granting, webhooks, the fetch/ingest path                                          | the shipped GitHub / GitLab integrations | Panel A's single action deep-links to Settings → Workspace; this asset does not re-draw granting.                                                                                                                                            |

---

## 2. The panels

| #     | state                                     | what it draws                                                                      |
| ----- | ----------------------------------------- | ---------------------------------------------------------------------------------- |
| **0** | **THE DOORS**                             | Both access paths, in situ, with the host dimmed.                                  |
| **A** | no repo, project **has** implemented work | The connect aside — shown, and its dismissed collapse.                             |
| **B** | no repo, **nothing** implemented          | Nothing is drawn. The deliberate quiet state.                                      |
| **C** | connected and current                     | The per-repo code-context list.                                                    |
| **D** | connected, **stale**, **not moving**      | The warning register. D1 = 312 commits, D2 = 1 commit, D3 = the no-action variant. |
| **E** | planning without code context             | The anti-silence state, on `/planning`.                                            |
| **F** | **current again**                         | The moment the warning resolves.                                                   |
| **G** | **indexing**                              | A refresh genuinely in flight — the only moving state.                             |
| **H** | **never indexed**                         | Connected, but no graph has ever been built.                                       |
| **V** | the four verdicts                         | `current · stale · indexing · never indexed`, side by side.                        |

---

## 3. The ACCESS PATH (panel 0) — drawn, not described

Neither surface is a new page and neither gets a menu item. **The access path IS the position**, so
that is the thing the asset draws.

- **Door 1 · `/code-health`.** The connect aside renders **inside the audit report the user is already
  reading** — between the health-summary card and the findings card, which is exactly where
  `design/coding-convention/design-notes.md` Panel 1 places the §10.3 aside. Host:
  `app/(authed)/code-health/page.tsx`.
- **Door 2 · `/planning`.** The code-context strip sits at the **top of the workspace's right rail,
  above the composer**, so the answer to _"what can the planner see?"_ is beside the thing that is
  about to use it. Host: `app/(planning)/planning/page.tsx` →
  `components/planning/PlanningWorkspace.tsx`.

Both frames **embed** their host dimmed. This asset does not redraw the canvas, the rail's other
panes or the composer — those are `design/ai-chat/planning-workspace.mock.html` and
`design/ai-chat/plan-change-conversation.mock.html`, and the strip is composed into that workspace,
not beside a re-invented one.

---

## 4. The connect aside — INHERITED vs NEW

Source of the pattern: `design/coding-convention/design-notes.md` (its §10.3 block and Panel 6 state
gallery), built in `app/(authed)/code-health/_components/DeepenAuditCard.tsx`.

**Inherited wholesale — do not re-decide any of it:**

| element         | inherited value                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| container       | `--el-surface-soft` fill (**never** the report's white `--el-card`), `--el-border`, `--radius-card`, `--spacing-card-padding` |
| eyebrow         | "Optional · non-blocking", `--el-text-secondary`, 11 px, uppercase, letter-spaced                                             |
| dismiss         | ghost **×** (lucide `x`), `--el-text-muted`, top-right                                                                        |
| lead glyph      | lucide `scan-search`, `--el-accent-on-surface`                                                                                |
| title           | `--font-serif`, 16 px / 600, `--el-text-strong`                                                                               |
| sub             | 14 px, `--el-text-secondary`                                                                                                  |
| best-fit line   | 12 px / 500, `--el-text-secondary` — names the trigger                                                                        |
| dismissed state | collapses to a quiet one-line `--el-link` re-open row                                                                         |

**New here, and only this:**

1. **The subject.** The §10.3 aside connects a _scanner_; this one connects a _repository_.
2. **Two losses, not one.** The sub names **both**: plans are generated _without reading the
   codebase_, **and** _work items will not move themselves_ — pull-request → status sync rides the
   same connection. The second is often the more motivating half, so it is not a footnote.
3. **One action, not a tool choice.** The §10.3 aside offers two tool rows; this one offers a single
   **Connect a repository** primary button deep-linking to Settings → Workspace → GitHub / GitLab.
   There is nothing to choose between here — the provider choice belongs to the shipped grant flow.
4. **The trigger sentence.** The best-fit line reads _"N work items in this project have been
   reported implemented."_ — the honest state MOTIR-1767 settles.

### ⚠️ 4.1 Dismissal PERSISTS per project, per browser — CORRECTED 2026-09-05

**[MOTIR-1764]'s own body asserted, as a rung-2 finding, that dismissal is EPHEMERAL —
_"`DeepenAuditCard` holds it in `useState` and offers a re-open link"_. That reading is FALSE, and
the correction is recorded here rather than quietly designed around.**

The shipped precedent persists the flag in **`localStorage`, keyed per project**:

- `app/(authed)/code-health/_components/CodeHealthClient.tsx` defines
  `dismissKey(projectId) => 'motir:code-health:deepen-dismissed:' + projectId`, reads it through
  `useSyncExternalStore`, and writes `'1'` / removes it on dismiss and re-open.
- `DeepenAuditCard.tsx` holds `useState` only for `copied` and `expanded`. The **dismissal is the
  parent's**, which is why a read of the child alone concludes the opposite.
- `design/coding-convention/design-notes.md` Panel 6 State D already says so in words: _"the
  dismissal is per-project so it doesn't nag on every visit"_. The card's claim contradicted both the
  code and the note it cited as its pattern source.

**The half that WAS right stays right:** there is **no per-user dismissal store in the schema** —
`prisma/schema.prisma` carries `NotificationPreference` and `UserAppearancePreference`, neither of
which is a hint store. The conclusion drawn from that fact was the wrong one: the precedent does not
persist server-side, it persists **client-side**.

**So the drawn contract is:**

- Dismissing hides the aside for **that project in that browser, durably** — it survives a reload.
- A quiet one-line link re-opens it, and re-opening **clears** the stored flag.
- **No persisted "never show again" is drawn**, and no code card may invent a preference table for
  it. The behaviour is `localStorage` + `useSyncExternalStore`, a second use of a shipped pattern.
- `localStorage` is per browser. The same project on another device shows the aside again. That is
  the precedent's behaviour and the copy never over-promises otherwise.

This supersedes [MOTIR-1754]'s acceptance criterion _"Dismissal is session-scoped … nothing is
persisted"_, which was written from the same misreading. Both cards are amended on the record.

---

## 5. Drift is stated in COMMITS — and why an age is a _wrong_ verdict, not a weaker one

**State D leads with the drift: "312 commits behind".** No panel expresses the verdict as an age.

The reason is not tone. **Age and drift disagree about the answer:**

- A graph built three weeks ago on a repository nobody has pushed to is **current**. Motir is
  planning against exactly the code that is there.
- A graph built two hours ago on a repository that took 300 commits since is **badly stale**. Motir
  is planning against code that no longer exists.

An age-led verdict gets both of those backwards. So _"indexed 3 days ago"_ may appear as **secondary
detail beside the drift** — it never leads, and the verdict is never derived from it.

**The drift count is the code card's input, not the design's invention.** The surface needs a
`commitsBehind: number | null` beside the verdict:

- a **number** → _"N commits behind"_ in the headline, and _"N behind"_ on the chip;
- **`null`** → _"Behind by an unknown number of commits"_ in the headline, and **"Behind"** on the
  chip (panel D3). A chip reading **"Stale"** is the age framing in miniature and is not drawn.

**⚠️ This is an obligation this design places on [MOTIR-1767].** That card's verdict function, as
authored, distinguishes `stale` from `current` by comparing `indexedCommitSha` with the stored
`GithubRepo.lastPushSha` — a sha _inequality_, which yields a boolean and not a count. A count needs
a source, and the constraint it inherits from [MOTIR-1766] is that **no provider round-trip may
happen on a page render**. Which mechanism supplies it is 1767's decision; that it must be supplied,
and that `null` is a legal answer this surface renders, is settled here. 1767 is amended on the
record accordingly.

---

## 6. Registers — where the inherited §10.3 grammar STOPS

Three rungs, and the split is the whole reason state D is not another aside:

| rung           | used by                                               | fill / edge                                                                                                                       | reading                                                                    |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **invitation** | panel A (connect aside), panel B (nothing)            | `--el-surface-soft`, `--el-border`                                                                                                | _optional; the thing you are reading is already complete_                  |
| **warning**    | panel D (stale, not moving), panel E (planning blind) | `--el-warning-surface` fill + a `--el-warning` **edge**, ink `--el-warning-text`, glyph lucide `triangle-alert` in `--el-warning` | _a fact that degrades the product's output; you should not skim past this_ |
| **error**      | —                                                     | not used                                                                                                                          | nothing in this story is an error                                          |

**Where the inherited register stops:** the §10.3 anatomy is an **invitation** — it exists to deepen
an already-complete report and must never gate it. State D is **not that**. It reports that plans are
being produced against code that is not the code, which is a defect in the output rather than an
optional improvement to it. Stretching one aside grammar over both would make the warning read as
optional, so the asset does not: D takes the token layer's own warning family, one rung up, and keeps
the aside grammar for A alone.

**Still not alarming.** No red, no destructive family, no modal, no blocking. The weight comes from
the peach warning surface plus a coloured **edge** — the one thing panel A does not have — and from
the copy naming a consequence in words.

**State D's colour is not invented.** It is the existing warning family in
`packages/design-system/theme.css`: `--el-warning-surface` (`--color-tint-peach`), `--el-warning`
(`--color-warning`) and `--el-warning-text` (`--color-charcoal`). Both flip with the theme, verified
in `code-context.dark.png`.

### 6.1 ⚠️ `stale` and `indexing` are TWO states, and only ONE of them is moving

The earlier direction — _stale "must read as catching up, not broken"_ — is **superseded, and the
"catching up" half is actively wrong.** A refresh can be paused, failing, or impossible for the
provider entirely. **A stale repository may sit stale for ever.**

**The copy rule, in words:**

- **Panel D (`stale`) promises nothing.** No _"catching up"_, no _"shortly"_, no _"check back"_, no
  _"this will resolve"_. It states the drift, states the consequence, says **"This index is not
  updating."**, and offers the action that exists — or, in D3, says plainly that none can be started.
- **Panel G (`indexing`) is the only panel allowed wait-and-return language.** It is the only state in
  which something is actually happening.
- **A run that cannot prove a refresh is in flight renders D, never G.** The default is the one that
  promises nothing.

They are separated at a glance by three things at once: **surface** (peach warning vs sky info),
**glyph** (static `triangle-alert` vs spinning `loader-circle`) and **copy**. Never by colour alone.

### 6.2 The action on state D

D1/D2 offer a secondary **"Rebuild now"** (lucide `refresh-cw`), composing the shipped
**"Re-audit now"** grammar from `DeepenAuditCard.tsx`. It **reuses the refresh enqueue [MOTIR-4604]
already fires at session start** — it is not a new mechanism, and [MOTIR-1768] wires it.

**D3 has no button at all.** Where nothing can be enqueued the honest rendering offers no action and
says so: _"No rebuild is offered, because none can be started."_ An action that cannot succeed is
worse than none.

---

## 7. Per-element token + primitive map, and who specifies each behaviour

The code card composes these; it does not choose new ones.

| element                                    | primitive                                                  | colour tokens                                                        | shape tokens                              | behaviour specified by                                                           |
| ------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| connect aside container                    | `components/ui/Card.tsx` grammar, **soft** variant         | `--el-surface-soft`, `--el-border`                                   | `--radius-card`, `--spacing-card-padding` | §10.3, `design/coding-convention/design-notes.md`                                |
| aside eyebrow                              | `components/ui/SectionLabel.tsx`                           | `--el-text-secondary`                                                | —                                         | §10.3                                                                            |
| aside lead glyph                           | lucide `scan-search`                                       | `--el-accent-on-surface`                                             | —                                         | §10.3                                                                            |
| aside title                                | serif heading                                              | `--el-text-strong`                                                   | `--font-serif`                            | §10.3                                                                            |
| dismiss ×                                  | ghost icon button                                          | `--el-text-muted`                                                    | `--radius-control`                        | §4.1 (this file)                                                                 |
| re-open link                               | text link                                                  | `--el-link`                                                          | —                                         | §4.1 (this file)                                                                 |
| **Connect a repository**                   | `components/ui/Button.tsx` `variant="primary" size="sm"`   | `--el-accent` / `--el-accent-text`                                   | `--radius-btn`, `--height-btn-sm`         | the shipped grant flow                                                           |
| **Rebuild now**                            | `components/ui/Button.tsx` `variant="secondary" size="sm"` | `--el-text`, `--el-button-border`                                    | `--radius-btn`, `--height-btn-sm`         | [MOTIR-4604] (the enqueue), [MOTIR-1768] (the wiring)                            |
| repo row                                   | list row on a card                                         | `--el-card`, `--el-border`, `--el-text-strong`                       | `--radius-card`                           | [MOTIR-1767] (the DTO)                                                           |
| commit sha                                 | mono inline                                                | `--el-text-secondary`                                                | `--font-mono`                             | [MOTIR-1765] (`commitSha`)                                                       |
| verdict `current`                          | `components/ui/Pill.tsx`                                   | `--el-success-surface` + `--el-text-strong`, glyph `circle-check`    | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `stale`                            | `components/ui/Pill.tsx`                                   | `--el-warning-surface` + `--el-warning-text`, glyph `triangle-alert` | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `indexing`                         | `components/ui/Pill.tsx`                                   | `--el-notice-info-bg` + `--el-text-strong`, glyph `loader-circle`    | `--radius-badge`                          | [MOTIR-1767]                                                                     |
| verdict `never indexed`                    | `components/ui/Pill.tsx`                                   | `--el-muted` + `--el-text-secondary`, glyph `circle-dashed`          | `--radius-badge`                          | [MOTIR-1765] (`indexed: false` + null fields)                                    |
| stale warning block                        | callout                                                    | `--el-warning-surface`, `--el-warning` edge, `--el-warning-text`     | `--radius-card`                           | §5, §6 (this file)                                                               |
| indexing block                             | callout                                                    | `--el-notice-info-bg`, `--el-info` glyph                             | `--radius-card`                           | [MOTIR-1767] (`indexing`)                                                        |
| settled line (F)                           | inline banner                                              | `--el-success-surface`, `--el-success` glyph                         | `--radius-card`                           | §8 (this file)                                                                   |
| planning-blind block (E)                   | callout                                                    | `--el-warning-surface`, `--el-warning` edge                          | `--radius-card`                           | `lib/ai/codeContext.ts` (`resolveCodeContext` returning `undefined`)             |
| the head sha staleness is compared against | —                                                          | —                                                                    | —                                         | [MOTIR-1766] (`GithubRepo` head columns, `lib/services/githubWebhookService.ts`) |

**Two shape rules the code card must not break.** State is never signalled with a hardcoded **dashed
or dotted border** — it clashes with `data-style`; use a token-driven tint plus a label and a glyph.
And no raw utility (`rounded-md`, `p-2`, `h-9`) or Tier-0 `--color-*` — element tokens and the
element-semantic shape tokens only.

---

## 8. State F — the warning must be seen to clear

Without F the honest warning this story adds never visibly resolves, which teaches people to ignore
it. A refresh lands while the surface is open:

- the warning block is **replaced in place** by a settled line — _"Code graph rebuilt — now current at
  `9c14e02`."_, `--el-success-surface`, lucide `check` in `--el-success`;
- the repo row underneath returns to its panel C reading;
- **quiet, once, and self-erasing** — it is gone on the next read.

**Not a toast queue** (it belongs in the slot the warning occupied, so nothing moves and nothing has
to be dismissed) and **not a persistent badge** (a badge that stays re-creates the nagging the §10.3
register exists to avoid).

---

## 9. State B — what a project with nothing shipped yet sees

**Nothing.** Both hosts render exactly what they render today.

The trigger for the aside is **implemented work**, not **absent repository**: a project that has not
shipped anything does not need to be asked for a repository that does not exist yet. Asking at
onboarding time would be wrong for the same reason. [MOTIR-1767] settles the predicate — any work
item with a non-null `implementationSource`, which is exactly _"someone reported implementing work"_
— and it is deliberately not _"any done item"_ (a migrated project is full of those) and not _"any
pull-request link"_ (that presumes the very connection the aside is asking for).

The dimmed outline in panel B marks the space the aside would occupy. It exists so a reader can see
the absence is a **decision**, and is not itself a drawn element.

---

## 10. Accessibility and theme

- Every state is carried by **tint family + glyph + copy**, never by colour alone (WCAG 1.4.1).
- Ink is `--el-text-strong` / `--el-warning-text` on tinted surfaces; the warning family's
  charcoal-on-peach pairing is the one `theme.css` already holds to its AA bar.
- Both themes are exported. `code-context.dark.png` is the same board with `data-theme="dark"` on the
  root; every ink flips because `color` is declared on the scoped containers rather than inherited
  from `body` alone.

---

## 11. How this asset was produced

The mock is **generated, not hand-typed**, so it cannot drift from the shipped layer:

1. **Tokens.** A throwaway script strips comments from `packages/design-system/theme.css`, then
   brace-counts three blocks out of the comment-stripped source: the Tier-0 `@theme` block (re-emitted
   as `:root`), the Tier-3 `:root, [data-appearance-scope]` block, and the `[data-theme='dark']` flip.
   Nested at-rule groups are dropped and each block's declarations are emitted **unlayered** into a
   leading `<style>`, with the Tier-3 block emitted a second time under a bare `[data-theme]`
   selector so a theme flip recomputes against its own Tier-0. 109 Tier-0 + 207 Tier-3 + 28 dark
   declarations. **No hex is retyped.**
2. **Icons.** Every `<symbol>` is the `__iconNode` array of the installed `lucide-react` icon file,
   following alias re-exports while keeping the requested id. The GitHub mark is taken verbatim from
   `components/icons/GithubMark.tsx`, because lucide ships no brand icons.
3. **Layout CSS** is hand-authored in the same semantic-class style as
   `design/coding-convention/design-notes.md`'s mock, and the button rules mirror
   `packages/design-system/src/components/ui/Button.tsx` variant for variant.
4. **Export.** `node scripts/render-design-mock.mjs design/code-context/code-context.mock.html --width 1200`
   (the width is passed explicitly — the script's viewport search keeps the first candidate matching
   on width and can lock in a half-width 2× render). The dark export is the same page with
   `data-theme="dark"` set on the root before a full-page screenshot.
5. **Verification** was by measurement, not by looking: a headless probe read back
   `--el-page-bg`, `--el-warning-surface`, `--el-warning`, `--el-surface-soft`,
   `--el-success-surface`, `--el-notice-info-bg`, `--radius-card`, `--spacing-card-padding` and
   `--shadow-card` as resolved values, confirmed every `<use href>` resolves to a defined symbol, and
   re-read the same properties with `data-theme="dark"` to confirm no ink collapses onto its own
   surface.

The generator scripts were deleted before the commit, so this section reproduces them rather than
citing a path that would not exist on `main`.

---

## 12. Amendments this design makes to sibling cards

Recorded here because a design that answers a card's open questions routinely changes that card, and
the change belongs on the record rather than in a build.

1. **[MOTIR-1764] (this card) and [MOTIR-1754] — dismissal persistence.** _"Session-scoped; nothing
   is persisted"_ is falsified by `CodeHealthClient.tsx`. See §4.1.
2. **[MOTIR-1767] — the drift count.** The verdict function needs to yield `commitsBehind`, with
   `null` a legal answer this surface renders. See §5.
3. **[MOTIR-1768] — the rebuild action.** Wiring **"Rebuild now"** to [MOTIR-4604]'s enqueue, and
   suppressing it where nothing can be started, is drawn here and is that card's to build. See §6.2.

[MOTIR-1754]: https://app.motir.co/items/MOTIR-1754
[MOTIR-1764]: https://app.motir.co/items/MOTIR-1764
[MOTIR-1765]: https://app.motir.co/items/MOTIR-1765
[MOTIR-1766]: https://app.motir.co/items/MOTIR-1766
[MOTIR-1767]: https://app.motir.co/items/MOTIR-1767
[MOTIR-1768]: https://app.motir.co/items/MOTIR-1768
[MOTIR-4541]: https://app.motir.co/items/MOTIR-4541
[MOTIR-4590]: https://app.motir.co/items/MOTIR-4590
[MOTIR-4601]: https://app.motir.co/items/MOTIR-4601
[MOTIR-4603]: https://app.motir.co/items/MOTIR-4603
[MOTIR-4604]: https://app.motir.co/items/MOTIR-4604
[MOTIR-4608]: https://app.motir.co/items/MOTIR-4608
[MOTIR-4609]: https://app.motir.co/items/MOTIR-4609
