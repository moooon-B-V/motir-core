# Billing · pricing · paywall — design notes

Design reference for the **`billing`** UI area — the **commercial surfaces** that
gate Motir's two billed products. Story 8.1 (Stripe billing + open-core tiering),
subtask **8.1.3** (card **MOTIR-1142**). The asset is the source of truth for the
two motir-core UI code subtasks, both `blocked` behind this design gate
(Principle #13 + the design-reference rule; `notes.html` #31):

| Code subtask                                                         | What it builds from this asset                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **8.1.7 / MOTIR-1148** — billing settings panel + plan/pricing UI    | Panels **1–6, 8** (settings panel, states, storefront, seats subscription, empty/error) |
| **8.1.8 / MOTIR-1149** — paywall / upgrade prompt at the AI boundary | Panel **7** (out_of_credits 402 + tier-gate + member variant)                           |

These two cards are linked to MOTIR-1142 as `relates_to` (with the boundary
service **8.1.6 / MOTIR-1147**) — they SPECIFY the flow this design draws; the
design GROUNDS in them and does not invent it. Built FROM the real design system
(`app/globals.css` `--el-*` colour tokens + the `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no design→code gap.

> **Refined by 8.1.15 / MOTIR-1302 (2026-06-23)** against the SHIPPED storefront
> (`app/(authed)/settings/organization/billing/_components/BillingClient.tsx`, built
> by 8.1.7 / MOTIR-1148) — three changes, each grounded in that component +
> `billing-tiering.md`, NOT invented:
>
> 1. **Seat upgrade screen (panel 6a, shipped `SeatsView`) gains a Monthly/Annual
>    `Segmented`.** `SeatsView` hardcoded annual (`checkout(seat.annual…)`, all-annual
>    terms); the catalog already carries `seatPlan.prices.monthly` (`$5`) +
>    `.annual` (`$40`), so the toggle re-prices the seat total, terms & CTA exactly
>    like the AI storefront's `PlansView`.
> 2. **The on-page cloud-only note (shipped `CloudNote`) is dropped.** The page is
>    `notFound()` off-cloud (`isCloudBilling()`), so it ONLY renders on cloud — the
>    banner is redundant. Self-host behaviour stays documented here in prose (the
>    "Self-host" section below), never as an on-page banner.
> 3. **The Motir AI pricing blocks (panel 5, shipped `PlanCard`) are redesigned**
>    from short cards (name + price + one credits line) to the standard SaaS tier
>    pattern (Linear / Vercel / Stripe): tall, equal-height cards in ONE row, each
>    with a per-tier use-case line + a cumulative "Everything in {previous}, plus …"
>    feature list.
>
> Code follow-ups blocked on this asset: **8.1.16 / MOTIR-1303** (seat toggle +
> drop the note) and **8.1.17 / MOTIR-1304** (pricing blocks).

| Surface                                                | Asset                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing settings · pricing storefront · AI paywall** | **`billing.mock.html`** (HTML mockup) | The whole commercial surface, 8 panels: access path · billing settings panel (2 billed lines) · panel states (past_due / trialing / canceled) · role gating · Motir AI plans & subscription (AI-only screen, Monthly/Annual toggle) · Motir seats plan & upgrade screen · AI paywall (402 + tier-gate) · empty/loading/error. A `billing.png` full-page export sits beside it (the board-visible face). |

## What this area is

The **org owner's home for money** — the surface that SELLS where the sibling
**`ai-usage`** dashboard only SHOWS. The two compose side by side in the
org-settings area and must not duplicate: **`ai-usage` = spend / balance / drill
/ run log; `billing` = plan / subscription / payment / checkout / paywall.** The
billing panel cross-links to Usage & cost (panel 2) rather than re-drawing the
balance dashboard.

### The locked model this draws (read at run time — do NOT invent)

Everything here is grounded in **`docs/decisions/billing-tiering.md`** (8.1.1 /
MOTIR-1138, **Accepted 2026-06-21**). The load-bearing facts:

> **Terminology (Yue, 2026-06-21): there is no "Tracker" customer-facing.** The
> two products' user-facing names are **"Motir"** (the PM tool — the seat plan)
> and **"Motir AI"** (the credit plan). "Tracker" survives ONLY as code
> identifiers — the `scaled-tracker` motir-core org flag and the
> `tracker_monthly` / `tracker_annual` Stripe price lookup keys — never as a UI
> label. This asset labels its two lines "Motir" and "Motir AI".

- **TWO independent billed products** (decision §1). Your bill = ① + ②, and they
  do not gate each other:
  - **① Motir** (the PM tool) — **free** for any team within the caps,
    **$5 / seat / mo** ($40 / seat / yr — the annual default, ~33% off) only when
    the org crosses a cap. The scaled state is a **motir-core org subscription
    flag**, NOT the AI tier.
  - **② Motir AI** (planning + agents) — an **org-level monthly credit plan**, prices
    firm from the Stripe sandbox catalog (8.1.2 / MOTIR-1141): **Free** (300
    credits, one-time trial, $0) / **Starter** ($5/mo · $40/yr, 300/mo) /
    **Standard** ($25/mo · $200/yr, 2,000/mo) / **Pro** ($75/mo · $600/yr,
    8,000/mo — the **recommended anchor**, `pro_pool_annual` is the Stripe default
    Price) / **Max** ($150/mo · $1,200/yr, 30,000/mo) / **Enterprise** (custom).
    This is the motir-ai `PlanTier`. Any org — free- or scaled-Motir — can buy it.
    Overage **credit top-up is $10 / 1,000** (one-time at Checkout).
- **Free-tier caps** (decision §4, drawn in the Motir line, panel 2): **≤ 250
  work items** (archived + active), **≤ 3 projects**, **1 workspace**, **10 MB /
  file**, **2 GB total**, **unlimited members**.
- **Subscription lifecycle** (decision §5) → the status `Pill`:
  `trialing` / `active` / `past_due` / `canceled`. `past_due` keeps access
  through the grace window with a warning banner; `canceled` drops to the free
  allotment, **data retained, never deleted**.
- **Credits are an internal ALLOTMENT, never a currency in-product.** The balance
  / allotment is labelled "credits" everywhere. The ONLY place a currency (`$`)
  appears is the **plan FEE** the org pays Stripe — the pricing storefront
  (panel 5) and the AI-plan fee line (panel 2). That is a price, not a credit
  count.
- **Permissions** (decision §7): billing **mutations are owner-only**; an **admin
  views** (read-only); a **member** is routed to an owner.
- **402 at the AI boundary.** motir-ai raises `out_of_credits` → **HTTP 402**
  (`OutOfCreditsError`, `src/problem.ts:16`), surfaced over the 7.1 boundary. The
  paywall (panel 7) handles it.

### Where it lives + the access path (panel 1)

- The billing surface lives in the **org-settings area**
  (`app/(authed)/settings/organization/…`), **org owner/admin gated** (a member
  gets the panel-4b routed-to-owner state, not a 404). It **REPLACES the passive
  `BillingPlaceholderCard`** (`_components/BillingPlaceholderCard.tsx`, the
  "Billing & usage — Coming soon" card) with the live surface.
- **Access path — drawn, not just named (mistake #31).** The shell TopNav **org
  menu** (the 6.10 org-admin menu holding Settings / Members / Usage & cost)
  carries a **"Billing & plans"** item — the row the `ai-usage` design left as a
  passive "Coming soon" now goes **active**. Selecting it opens the billing area;
  the settings stack shows the live **Billing card** (the door) where the
  placeholder used to sit. Panel 1 draws the TopNav, the open org menu with
  **"Billing & plans"** as the active row (`--el-tint-lavender`, the
  credit-card icon), and the destination settings stack — composing the shipped
  `Popover` + menu `opt` grammar, not a new control. Given the surface's size,
  8.1.7 MAY promote it to a dedicated `settings/organization/billing` route
  (sibling of `usage/`) — either way the access door is the org-menu row + the
  settings entry.
- **Data over the 7.1 boundary.** Subscription/tier figures are fetched
  client-side over the motir-core ↔ motir-ai boundary (the 8.1.6 billing service
  → 8.1.5 motir-ai endpoints): the loading skeleton (panel 8b) and the
  fetch-failed error (panel 8c) are real states. Numbers in the mock are
  illustrative.

### Self-host — these surfaces are CLOUD-ONLY

Billing **and** the §4 caps exist **only on cloud**, behind the **`MOTIR_CLOUD`**
flag (decision §6). On a self-hosted (GPL-3.0) build **none of these surfaces
render** — no Billing card, no paywall, no caps; Motir is unbounded and AI
is reached via the self-hoster's own connection. 8.1.7/8.1.8 MUST gate every
surface here behind `MOTIR_CLOUD` (a note states this on panel 7). This flag is
**distinct from** `isAiPlanningConfigured` (which gates whether AI is reachable).

> **No on-page "Cloud-only" banner (8.1.15 / MOTIR-1302).** Because the billing
> page already `notFound()`s off-cloud (`isCloudBilling()`), it ONLY ever renders
> on cloud — so a per-page "Cloud-only" banner (the old `CloudNote`) told the
> on-cloud reader something that is always true and never reaches the self-host
> reader at all. It is dropped from every panel. **This section is the canonical
> record of the self-host behaviour** — do not re-add an on-page banner.

---

## Panels (review EACH — mistake #31)

### Panel 1 — access path (the entry point)

The TopNav org menu OPEN with **"Billing & plans"** as the active row, and the
org-settings stack below with the live **Billing card** replacing the passive
placeholder. The card carries a one-line summary (`Motir · Free`, `Motir AI ·
Standard`, an `Active` status `Pill`) and an **Open** affordance. The door is
drawn; the room is panels 2–7.

### Panel 2 — billing settings panel (owner, populated & active — the PRIMARY view)

A `stack` of `Card`s under the `Organization · {org} · Billing & plans`
breadcrumb. The two billed lines + payment:

- **① Motir line (`Card`).** Head: a mint product glyph (`i-layers`), title
  **"Motir"**, a state `Pill` (**"Free"** neutral / **"Scaled"** when paid).
  Body on `free`: a one-line explainer, then a **caps grid** of three cells —
  **Work items** `182 / 250`, **Projects** `2 / 3`, **Storage** `0.4 / 2 GB` —
  each with a token-only `.meter`. Then a **seat preview** (`.seatcalc`): the
  member avatars + **"Scaling bills 1 seat per member — 6 today"** and the
  resolved total **"6 × $5 = $30 / mo"**, so the per-seat price is concrete before
  the user ever clicks. Action: **"Upgrade Motir"** + a **"Seats follow membership
  · prorated automatically"** caption. (On a `scaled` org the caps grid is replaced
  by the billed seat count + renewal and the action is "Manage seats" — panel 6b.)
- **② Motir AI line (`Card`).** Head: a lavender product glyph (`i-sparkle`),
  title **"Motir AI"**, the subscription status `Pill` (**Active**). Body: a tier
  `Pill` (**"Standard"**) + the subscription amount **"2,000 credits / mo"** +
  — **when the org holds purchased top-ups — an `--el-tint-sky` `pill-topup`
  beside it: `+3,000 top-up`** (the EXTRA credits, distinct from the recurring
  allotment) + the **plan fee "$25 / mo"** (right-aligned). Then the **allotment
  meter** with **"1,420 of 2,000 left"**, and a second `meterlbl` totalling the
  two pools: **"+3,000 top-up credits (extra · don't expire)"** | **"4,420 credits
  available"**. The `desc` notes **"monthly allotment resets; purchased top-up
  credits roll over"**. (No top-up held → the `pill-topup` + the total line are
  omitted; the meter reads the allotment alone.) Actions:
  **"Change plan"** (primary → panel 5), **"Manage plan & payment"** (secondary,
  `i-external` → Stripe Customer Portal), and the **"View Usage & cost"**
  cross-link (`i-coins`, to the `ai-usage` dashboard).
- **Payment & invoices (`Card`).** A payment-method row (card brand chip + `••••
4242` + expiry + an Update affordance) and a **"Stripe Customer Portal"**
  button (`i-external`) — the Portal owns invoices, VAT ID, payment-method change
  and cancellation. A dashed `note` states tax is applied automatically.

### Panel 3 — panel states (the non-happy subscription lifecycle, decision §5)

- **(a) `past_due` / dunning.** The status `Pill` is **"Past due"** (`pill-pastdue`);
  a **`--el-tint-yellow` warning banner** ("We couldn't charge your card… stays
  active while we retry over ~2 weeks") with an **"Update payment"** primary
  action; the allotment meter fills in `--el-warning`. Access is KEPT through
  grace.
- **(b) `trialing` / Free (one-time grant).** Status `Pill` **"Free trial"**
  (`pill-trial`, sky); the one-time **"185 of 300 credits left"** meter; copy
  that the grant doesn't refresh; a **"Choose an AI plan"** primary.
- **(c) `canceled` → free.** Status `Pill` **"Canceled"** (`pill-canceled`, rose);
  a **`--el-tint-rose` banner** stating the plan ended, the org is back on the
  free allotment, and **nothing was deleted** (plans / work items / history
  intact); a **"Resubscribe"** primary.

### Panel 4 — role gating (decision §7)

Two mini-surfaces side by side so the gate is visible:

- **(a) Org admin — view-only.** The same AI-plan card with a **"View only"**
  `Pill` (`i-eye`), the allotment meter, and **no** Change-plan / Portal buttons;
  a lock `note` explaining changing the plan / payment / cancelling is
  **owner-only**.
- **(b) Org member — no billing access.** An `EmptyState`-style gate (`i-lock`,
  `--el-tint-lavender` icon) — **"Billing is managed by your org owner"** — with
  a **"Contact an owner"** secondary, never a dead billing control.

### Panel 5 — Motir AI — plans & subscription (a SEPARATE, AI-ONLY screen)

> **Why its own screen (Yue, 2026-06-22).** The two products are **independent**
> (ADR §1 — "neither gates the other"), so the AI plan gets its **own screen**, not
> a shared "choose your plans" page bundling seats. A user who **already pays for
> seats** should not wade through the seat plan to change AI — and vice-versa. So:
> **Motir AI lives here (panel 5); Motir seats live on their own screen (panel 6);
> neither screen shows the other product.** The billing home (panel 2) is the hub
> with one line per product, each routing to its own screen: the Motir-AI line's
> **"Change plan"** → here; the Motir line's **"Upgrade Motir"** → panel 6.

Reached from the Motir-AI line's "Change plan" (panel 2) and the paywall (panel 7),
under the `… · Motir AI` breadcrumb. The screen is **pricing AND subscription**:

- **Current-subscription strip (`.curbar`).** At the top: the active AI plan — a
  **"Standard"** tier `Pill` + **"Active"** status `Pill` + "2,000 credits / mo ·
  1,420 left · renews 1 Jul 2026" + a **"Manage plan & payment"** (→ Portal)
  button. So a returning subscriber sees their state first, then the ladder to
  change it. (Omitted / replaced by a "no AI plan yet" line for a free-AI org.)
- **Monthly / Annual cadence toggle (the SaaS-standard pricing control).** A
  `Segmented` ("Monthly" | "Annual") sits **below the headline, above the cards** —
  the single highest-impact control on a pricing page. **Annual is the default**
  (the Stripe annual default; defaulting to annual lifts annual adoption ~25–35%)
  with a **"Save ~33%"** `seg-badge`; **Monthly is always available** (hiding it
  erodes trust). It re-prices the ladder (`setCadence()` flips
  `.store[data-cadence]`; CSS shows `.cad-a` / `.cad-m`). The pattern follows the
  verified SaaS convention (mirror below):

- **Annual selected (default):** each paid card shows the **per-month equivalent**
  (`$50 / mo`, not the yearly lump) with a `billed annually · $600 / yr` subline
  and a green **`Save $300/yr`** `save` pill — **dollar** savings, which beat a
  bare "%". (Per-month-equivalent + dollar-savings are the two display rules the
  mirror sources converge on.)
- **Monthly selected:** the card shows the monthly fee (`$75 / mo`) with a
  `$900 / yr · Save $300 with annual` nudge back toward annual.
- The `$0` Free cards and the **Enterprise** (Custom) card are cadence-inert.

The PNG captures the **Annual** default. 8.1.7 wires the toggle to the two
annual/monthly Stripe Prices (`*_annual` is the Product's default Price).

The cards (AI ladder only — the Motir seat plan is panel 6, never shown here):

- **The Motir AI ladder — the standard SaaS pricing-tier pattern** (rung 1 —
  Linear / Vercel / Stripe). Six `plan` cards that are **TALL, equal-height, and laid
  out in ONE row** (the `.ai-grid` is a `display:flex` row, `align-items:stretch`
  equalising height so the CTAs sit on a common baseline; `flex:1 0 0` +
  `min-width:158px` per card). **Responsive rule (drawn):** below the row's natural
  width the container **scrolls horizontally** (`overflow-x:auto`, scroll-snap) —
  the six tiers stay one comparable ladder, never wrapping to a second row or
  dropping tiers. Each card, top → bottom:
  1. **Tier name** (+ `i-zap` / `i-crown` accent glyph for Pro / Max, + the
     "Current" / "Recommended" `Pill`).
  2. **A per-tier USE-CASE line (`.use`, who it's for)** — the new top-of-card
     line, secondary colour, ~2-line `min-height` so the price rows align across
     cards: **Free** "Try it out — a one-time taste of Motir AI." / **Starter**
     "Light planning — a recurring taste, every month." / **Standard** "Heavy
     planning, plus light agent tasks." / **Pro** "Frequent planning, plus serious
     agent tasks." / **Max** "Heavy agent throughput for a busy team." /
     **Enterprise** "Custom volume, plus organization controls."
  3. **The cadence-aware price** (serif `.amt`) + the billed/save subline.
  4. **The credit allotment** (`.alot`, the load-bearing figure, bold).
  5. **A CUMULATIVE `i-check` feature list** — each paid tier opens with a flush-left
     `.flead` caption **"Everything in {previous tier}, plus"** (no glyph), then its
     incremental extras: **Starter** → "300 credits refreshed monthly" · "Metered
     top-ups"; **Standard** (everything in Starter) → "2,000 credits / mo (~10
     planning passes)" · "Headroom for light agent tasks"; **Pro** (everything in
     Standard) → "8,000 credits / mo" · "Planning + a run of hosted coding"; **Max**
     (everything in Pro) → "30,000 credits / mo" · "Design, docs & coding across
     epics"; **Enterprise** (everything in Max) → "Invoiced billing & SSO" ·
     "Dedicated support". **Free** is the base (no "Everything in"): "Full planning,
     design & coding agents" + an `off` (`i-x`, faint) "No monthly refresh · no
     top-ups".
  6. **A per-tier CTA → Checkout** (pinned to the bottom via `margin-top:auto`).

  Tiers: **Free** (`$0` once · 300 credits · one-time, "Trial used") / **Starter**
  (`$5` → `$3.33/mo` · $40/yr · save $20 · 300) / **Standard** (`$25` → `$16.67/mo`
  · $200/yr · save $100 · 2,000, marked **Current**) / **Pro** (`$75` → `$50/mo` ·
  $600/yr · save $300 · 8,000, `i-zap` accent, marked **Recommended** — the anchor
  tier) / **Max** (`$150` → `$100/mo` · $1,200/yr · save $600 · 30,000, `i-crown`
  accent) / **Enterprise** (Custom). The current plan is accent-bordered + disabled
  CTA; the recommended Pro card is accent-bordered (`feat rec`) with a "Recommended"
  `Pill`. A footer `note` states annual-is-shown / switch-to-monthly,
  tax-at-checkout, credits-vs-price, and that **seats are billed separately —
  manage them on the Motir plan screen (panel 6)** (the only cross-product link).

**Credit top-up (the one-time overage purchase — `creditService.topUp()`).** Below
the ladder, a **"Top up credits"** `Card`: the recurring plan covers the monthly
allotment, top-ups are the **pay-as-you-go overage** beyond it (ADR §2/§3,
`credit_topup` Stripe Price, `mode: 'payment'` one-time). It shows the current
**balance** + allotment-used line, a row of **bundle** options
(**1,000 · $10 / 5,000 · $50 / 10,000 · $100 / Custom × 1,000**, one selected with
the accent border), a **"Buy {n} credits — ${total}"** CTA, and the rate line
(**"$10 per 1,000 credits · one-time · tax at checkout"** — a price the org pays
Stripe, distinct from the in-product credit allotment). A `note` gates it:
**top-ups need a paid AI plan — the Free trial can't top up** (matching the §2
table: Free has no top-ups), **owner-only** (§7). The paywall's "Buy credit
top-up" (panel 7a) routes here. (`$` is legitimate here — it's a purchase price,
not the credit allotment, which is never shown as currency.)

> **Mirror (rung 1 — cited).** The monthly/annual toggle is the SaaS-standard
> pricing control: place it below the headline above the cards, **default to
> annual** with a visible discount, show the **per-month equivalent** for annual
> ("$50/mo, billed annually" beats "$600/yr"), quote the **dollar** saving ("Save
> $300/yr" beats "20% off"), and **always keep monthly** available.
> ([InfluenceFlow — SaaS pricing best practices 2026](https://influenceflow.io/resources/saas-pricing-page-best-practices-a-complete-2026-guide/);
> [PipelineRoad — what converts in 2026](https://pipelineroad.com/agency/blog/saas-pricing-page-best-practices))

### Panel 6 — Motir (seats) plan & upgrade screen (the seat-only counterpart to panel 5)

This is the **Motir seat plan's own screen** — the parallel to the AI screen
(panel 5), kept separate for the same reason: it shows seats only, never the AI
plan. Reached from the Motir line's "Upgrade Motir" (panel 2). Seat = member,
billed per-seat:

Motir Scaled is billed **one seat per organization member** — the seat item's
Stripe `quantity` syncs to membership (ADR §3). So the design **shows the seat
count wherever the seat price appears**, never an abstract "$5/seat" alone. Two
sub-surfaces:

- **(a) BEFORE — upgrade review (before Checkout).** A width-constrained `Card`
  (a confirmation dialog) titled **"Scale up Motir"**. **A Monthly/Annual
  `Segmented` cadence toggle sits at the top of the body** (8.1.15 — the seat screen
  hardcoded annual before; this is the same control the AI storefront uses, labelled
  "Billing", **Annual default** with a "Save ~33%" `seg-badge`, **Monthly always
  available**). It re-prices everything below it (`setCadence()` flips
  `.store[data-cadence]`; the cadence-tagged `.cad-a` / `.cad-m` spans show/hide —
  the catalog carries `seatPlan.prices.monthly` `$5` + `.annual` `$40`). Then a
  `.seatcalc` (member **avatars** + **"6 members → 6 seats"** + the cadence-aware
  total — **"6 × $40/yr = $240 / yr"** annual / **"6 × $5/mo = $30 / mo"** monthly),
  then a **`.terms` key/value list that spells out what & when we charge** — the part
  a narrow note couldn't carry:
  - **Billing** — _annual:_ Annual, $240/yr ($20/mo equiv, the default), with a green
    **"Saves $120/yr vs monthly"** `save` badge; _monthly:_ Monthly, $30/mo ($360/yr
    — switch to annual to save $120).
  - **Due today** — _annual:_ $240, **prorated** to the renewal date (less for the
    days left this term); _monthly:_ $30, **prorated** to the renewal date.
  - **Add a member later** — a **prorated charge** for the new seat, for the rest of
    the term.
  - **Remove a member** — a **prorated credit** on the next invoice — **no mid-term
    refund**.

  Then a short `note` (seats follow membership automatically via Stripe proration;
  pick Monthly/Annual above before continuing — the old "switch at Checkout" line is
  obsolete now the toggle is in-page) and the **cadence-aware CTA** (**"Continue to
  Checkout — $240/yr"** annual / **"— $30/mo"** monthly) + Cancel. (Implementation
  note: a `.note` is `display:flex`; its text MUST be wrapped in ONE `<span>` — bare
  text + inline `<b>` become separate flex items and shred into narrow columns. The
  cadence variants use bare `.cad-a` / `.cad-m` hooks — the visibility rule keys on
  those classes, not on `.cad`, so they stay plain inline spans, no `.price`
  inline-flex.)

- **(b) AFTER — the live Motir seats subscription (full-width).** The **scaled
  counterpart to panel 2's free-Motir line** — same `Card` grammar as the Motir-AI
  line, so the paid Motir plan reads as a real subscription, not a fragment. Head:
  the `i-layers` glyph, **"Motir"** / "scaled seats subscription", an **"Active"**
  status `Pill`. Body: a `.row1` with a **"Scaled"** tier `Pill` + **"6 seats"** +
  the right-aligned **"Plan fee $240 / yr"** + an **"Annual · saves $120/yr"**
  `save` pill; a `.seatcalc` (avatars + **"6 seats billed · 1 per member"** + **"6 ×
  $40/yr = $240 / yr"**); a `desc` — **"Billed annually · $20/mo equiv · renews 1
  Jul 2026. All free-tier caps lifted … seats track membership: adding a member adds
  a prorated charge for the rest of the term; removing one applies a prorated credit
  to the next invoice (no mid-term refund)."**; actions **"Manage seats"** (`i-users`),
  **"Manage plan & payment"** (→ Portal), and a **"Switch to monthly billing"**
  cross-link. (This is the surface the user lands on after subscribing; panel 2
  shows the same org's Motir-AI line + the _free_ Motir line. The plan defaults to
  the **annual** rate — the Stripe annual default the storefront also defaults to.)

> **Mirror (rung 1 — cited).** Showing the billed seat count at upgrade is how
> both reference PM tools work. **Linear** bills for the number of **active
> (unsuspended) members** in any role, surfaces that count in Settings → Billing,
> and **prorates** mid-cycle changes by date. **Jira** bills per user and shows
> the **user tier** you occupy. Motir mirrors Linear's "seats = active members,
> prorated" model (the closer fit — Motir caps scope like Linear, not seats).
>
> **Mid-cycle changes on an ANNUAL seats plan — what & when (the panel-6 copy).**
> Both mirrors agree, and Motir (Stripe proration, ADR §5) follows them:
>
> - **Add a member mid-term → a prorated CHARGE for the new seat covering the rest
>   of the annual term**, at the annual per-seat rate. _Linear_ generates a
>   prorated charge for the remaining year, reconciled on a **monthly true-up**
>   invoice tied to the annual start date (charged automatically); _Jira_ charges
>   the added seat prorated through the remainder of the annual term. (Motir =
>   Stripe `create_prorations`; surface it as "a prorated charge for the rest of the
>   term".)
> - **Remove a member → a prorated CREDIT applied to future invoices, NOT a cash
>   refund; the annual total does not drop mid-term.** _Linear_ issues a credit on
>   suspension applied to future invoices; _Jira_ defers the reduction to the next
>   billing cycle. (Motir mirrors this: credit-to-next-invoice, no mid-term refund.)
>
> ([Linear — Billing & plans](https://linear.app/docs/billing-and-plans);
> [Atlassian — manage users & user tiers](https://support.atlassian.com/subscriptions-and-billing/docs/manage-users-and-user-tiers/))

> **Implementation owner (do NOT build it here).** The mechanism behind this
> proration — keeping the Stripe seat `quantity` in sync with org membership on
> invite/remove — is **8.1.12 / MOTIR-1256** (a motir-ai `seat-quantity` endpoint
>
> - a motir-core membership-change hook, behind `MOTIR_CLOUD`, surfaced as a
>   planning gap on 2026-06-22). It is NOT in 8.1.7/8.1.8: those render these states
>   (the panel-6 subscription card + the invite-time seat note); the seat-quantity
>   write itself is 8.1.12. Inviting a member **does not** pop a Checkout/pay-wall —
>   the seat count updates and Stripe accrues the prorated delta to the **next
>   invoice** (auto-charged on the card on file; a monthly true-up for annual).

### Panel 7 — paywall at the AI boundary (8.1.8)

The in-product upsell. **This ACTIVATES the passive "out of credits" slot the
`ai-usage` design drew** (its panel 7b `.passive-slot`, shipped as
`OrgUsageClient` `OutOfCreditsCard`) — that placeholder becomes a real Upgrade
CTA here.

- **(a) `out_of_credits` (402), owner — at the planner composer.** The AI entry
  (a faded compose bar + disabled **Plan** button) over a **blocked** `state`
  (`i-pause`, `--el-tint-yellow` icon): **"Planning is paused — you're out of
  credits"**, NAMING the limit ("all of this month's 2,000 Standard credits"),
  with an **active "Upgrade plan"** primary (`i-arrow-up`) + **"Buy credit
  top-up"** secondary. Existing plans stay editable.
- **(b) Tier-gate — free org that never bought AI.** A `gate` state (`i-sparkle`,
  `--el-tint-lavender`): **"AI planning is a paid feature"** with **"See AI
  plans"** primary + **"Maybe later"** ghost; mentions the 300 free trial
  credits.
- **(c) Member variant — can't buy.** A `gate` state (`i-lock`): **"AI is out of
  credits for this org"** with **"Ask an owner to upgrade"** — never a dead CTA
  (decision §7: a member's prompt routes to an owner).

### Panel 8 — empty / loading / error

- **(a) Empty / first-run** — no Stripe customer yet: a `state` (`i-card`),
  **"You're on the free plan"**, **"See plans"** CTA.
- **(b) Loading** — the panel `Skeleton` (`aria-busy`) while fetching status over
  7.1.
- **(c) Error** — the billing fetch failed (boundary/Stripe down): an error
  `state` (`i-alert`, `--el-tint-rose` icon), **"Couldn't load billing"**, "your
  subscription and credits are safe", a **Retry** secondary — not a
  broken-looking zero.
- A closing dashed `note` states the **cloud-only / `MOTIR_CLOUD`** gate
  (self-host hides everything here).

---

## Primitives composed (no hand-rolling)

Every surface composes a shipped `components/ui/*` primitive; the mock mirrors
the `ai-usage` mock's grammar so 8.1.7/8.1.8 reuse the same code. If they need a
genuinely new primitive, that is a **new `design/` subtask**, not a code
workaround.

- **`Popover` + menu rows (the access path, panel 1)** — the org menu's `opt`
  rows (the org-admin switcher grammar): rows at `--spacing-control-*` /
  `--radius-control`, the active **"Billing & plans"** row `--el-tint-lavender`.
- **`Card`** — every line (Motir / Motir AI / payment), the state cards, the
  plan cards, the loading skeleton wrapper (`--radius-card`, `--shadow-card`,
  `--spacing-card-padding`; head/body/foot split by `--el-border-soft`).
- **`Pill`** — the **subscription-status** chips (Active / Free trial / Past due /
  Canceled / View only), the **tier** chip, the **Motir-state** chip, the
  **Current** marker. `--radius-badge`, `--spacing-chip-*`; **hue in the tint
  BACKGROUND with `--el-text-strong` text (finding #35 — AA-safe), never a tinted
  page surface.**
- **`Button`** — primary (Upgrade / Change plan / Resubscribe), secondary (Manage
  plan / Portal / Retry / Contact owner), ghost (Maybe later / Update). Heights
  `--height-btn-md` / `--height-btn-sm`; padding `--spacing-btn-x[-sm]`.
- **`Segmented`** — the **Monthly / Annual** cadence toggle, now on **BOTH** the AI
  storefront (panel 5) **and the seat upgrade screen (panel 6a — 8.1.15)**: the
  shipped `components/ui/Segmented.tsx` grammar — an `--el-surface` track
  (`--radius-btn`, 2px inset), each option `calc(--radius-btn - 2px)` so it nests at
  any style, the active option `--el-page-bg` + `--shadow-subtle`. A `aria-pressed`
  group; the Annual option carries the `Save ~33%` badge. Reuse it — do not
  hand-roll. (Both screens hold a local `BillingCadence` state defaulting to
  `'annual'`; `SeatsView` gains it, mirroring `PlansView`.)
- **Plan-card use-case + cumulative-feature lines (panel 5 — token-only, NO new
  primitive)** — the per-tier `.use` line is `--el-text-secondary` at the card top
  (a `min-height` aligns the price rows); the cumulative `.flead` lead
  ("Everything in {prev}, plus") is a flush-left `--el-text-secondary` caption (its
  `i-check` glyph hidden) introducing the `i-check` (`--el-success`) incremental
  bullets. Both are plain styled text inside the existing `.plan` card — no new
  component.
- **`EmptyState` / `ErrorState` family** — the member gate (4b), the tier-gate +
  member paywall (6b/6c), empty/error (7a/7c).
- **`Skeleton`** — the loading panel (7b).
- **Meter / bar (token-only)** — the allotment meter + the free-cap meters are
  plain token-styled `div`s (radius + tint), no charting lib, no image — the same
  `.meter` pattern as `ai-usage`.
- **Avatar stack + seat calc (panel 6, panel 2 preview)** — the overlapping member
  **avatars** reuse the shipped member-avatar token grammar (`--radius-badge`,
  pastel `--el-tint-*` fills + `--el-text-strong`, a `--el-page-bg` ring); the
  `.seatcalc` row is a token-styled `Card`-like band (`--el-surface-soft`,
  `--radius-card`, `--el-border-soft`) — no new primitive. 8.1.7 sources the seat
  count from membership (the seat `quantity`), not a hand-typed number.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                      | Token                                                             | Why                                                                                              |
| -------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Plan price / credit figures (serif)**      | `--el-text` · unit/`per` in `--el-text-muted`                     | The primary numbers; the unit/price-cadence reads quiet.                                         |
| **Tier chip (Standard / Pro / …)**           | `--el-tint-lavender` bg + `--el-text-strong`                      | The AI plan tier — brand-purple family, matches the org avatar.                                  |
| **Top-up chip (`+N top-up`)**                | `--el-tint-sky` bg + `--el-text-strong`                           | Purchased extra credits — a DISTINCT tint from the tier/allotment so the bonus pool reads apart. |
| **Status: Active**                           | `--el-tint-mint` bg + `--el-text-strong`, `i-check`               | Healthy / paid — success family.                                                                 |
| **Status: Free trial / trialing**            | `--el-tint-sky` bg + `--el-text-strong`, `i-sparkle`              | Informational, not yet paid — the info/try family.                                               |
| **Status: Past due (dunning)**               | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`   | Warning, recoverable — keep-through-grace, not danger.                                           |
| **Status: Canceled**                         | `--el-tint-rose` bg + `--el-text-strong`, `i-x`                   | Ended / dropped — danger family (but data retained).                                             |
| **Motir-state: Free / View-only / readonly** | neutral `Pill` (`--el-surface` + `--el-text-secondary`)           | Genuinely neutral state metadata.                                                                |
| **Allotment meter fill (healthy)**           | `--el-accent`                                                     | Primary "credits remaining" share.                                                               |
| **Allotment meter fill (low / past_due)**    | `--el-warning`                                                    | Low-balance / dunning variant.                                                                   |
| **Free-cap meters**                          | `--el-accent`                                                     | Usage-against-cap share.                                                                         |
| **Dunning / warning banner**                 | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning`   | Warning hue in the BANNER tint, not the page (finding #35).                                      |
| **Canceled banner**                          | `--el-tint-rose` bg + `--el-text-strong`, icon `--el-danger-text` | Ended-plan notice — danger tint in the banner only.                                              |
| **Info / tax / cloud-only notes**            | `--el-surface-soft` dashed (`--el-border-strong`) · `i-info`      | Quiet, dashed advisory — the passive-affordance shape.                                           |
| **Out-of-credits / paused icon**             | `--el-tint-yellow` + `--el-warning`                               | The paused state — warning, not danger (nothing is broken).                                      |
| **Tier-gate / lock-gate icon**               | `--el-tint-lavender` / `--el-surface` + `--el-text-strong`        | "AI is paid" / "ask your owner" — gate, not error.                                               |
| **Error icon tint**                          | `--el-tint-rose` + `--el-danger-text`                             | Fetch-error state (panel 8c).                                                                    |
| **Feature-list check / off**                 | `i-check` `--el-success` · off `i-x` `--el-text-faint`            | Included vs not — palette green, not grey-only.                                                  |
| **Pro / Max accent glyph**                   | `--el-accent-on-surface` (`i-zap` / `i-crown`)                    | The heavier paid tiers carry an accent glyph (accent AS icon).                                   |
| **Current-plan card border**                 | `--el-accent`                                                     | Marks the org's current plan in the storefront.                                                  |
| **Primary CTAs / Upgrade**                   | `--el-accent` + `--el-accent-text`                                | Upgrade / Change-plan / Resubscribe — the conversion action.                                     |
| **Cross-link (View Usage & cost)**           | `--el-link`                                                       | Quiet inline navigation to the sibling dashboard.                                                |
| **Payment card-brand chip**                  | `--el-tint-sky` + `--el-text-strong`                              | The Stripe payment-method affordance.                                                            |
| Text / surfaces / borders                    | `--el-text*`, `--el-surface*`, `--el-border*`                     | Standard element tokens — never Tier-0 `--color-*`.                                              |

All shaped surfaces use the **`[data-display-style]` shape tokens**
(`--radius-{btn,card,input,control,badge}`, `--spacing-{btn,input,control,chip,
card-padding}`, `--height-{btn-*,input,control}`, `--shadow-*`) — never the inert
Tier-0 radius/spacing scale or a fixed raw utility. `rounded-full`
(`--radius-badge`, `9999px`) is used only for the round avatar / pill caps.
Toggling the mock's dark mode confirms token parity (every colour flips through
Tier-0 under `--el-*`) — verified.

## Copy strings (en — the `billing` i18n namespace 8.1.7 / 8.1.8 add)

- Shell / nav: org-menu item **"Billing & plans"**; breadcrumb **"Organization ·
  {org} · Billing & plans"**; settings card title **"Billing & plans"** /
  subtitle **"Your Motir plan, Motir AI plan, payment method and invoices."**
- Page: title **"Billing & plans"**; subtitle **"Your two Motir products are
  billed independently. Motir is free until your org outgrows the free caps;
  Motir AI is an org-level credit plan you buy separately."**
- Motir line: **"Motir"** / **"The project-management tool — free for your team,
  paid only at scale."**; state **"Free"** / **"Scaled"**; explainer **"You're on
  free Motir — unlimited members, within the free caps below. You'll only pay $5 /
  seat / mo if the org crosses a cap."**; caps **"Work items"** `{used} / 250`,
  **"Projects"** `{used} / 3`, **"Storage"** `{used} / 2 GB`; **"Upgrade
  Motir"** / **"$5/seat"**.
- Motir AI line: **"Motir AI"** / **"Planning & hosted agents — an org-level monthly
  credit pool."**; **"{n} credits / mo"**; **"Plan fee"** `${n} / mo`;
  **"Allotment this month"** / **"{left} of {total} credits left"**; **"Renews
  {date}"** + **"credits are a usage allotment, not a bill — one planning run
  debits the tokens it used."**; **"Change plan"** / **"Manage plan & payment"** /
  **"View Usage & cost"**.
- Payment: **"Payment & invoices"** / **"Stripe Customer Portal"**; **"expires {mm
  / yy}"** / **"Update"**; note **"Payment method, invoices, VAT ID and
  cancellation are managed in Stripe's secure Customer Portal. Tax is applied
  automatically at checkout."**
- States: past_due **"Past due"** / **"We couldn't charge your card. Your Motir AI
  plan stays active while we retry over the next ~2 weeks. Update your payment
  method to avoid dropping to the free allotment."** / **"Update payment"**; trial
  **"Free trial"** / **"One-time trial grant"** / **"Your 300 trial credits are
  granted once and don't refresh. Pick a monthly Motir AI plan to keep planning when
  they run out."** / **"Choose a Motir AI plan"**; canceled **"Canceled"** / **"Your
  {plan} plan ended on {date}. The org is back on the free allotment — monthly
  credits and top-ups are off. Nothing was deleted; your plans, work items and
  usage history are all intact."** / **"Resubscribe"**.
- Role gating: admin **"View only"** / lock note **"You can see the plan, usage
  and invoices. Changing the plan, payment method or cancelling is limited to the
  organization owner."**; member gate **"Billing is managed by your org owner"** /
  **"Plans and payment for the {org} organization are visible to owners and
  admins. Ask an organization owner to change the plan or buy AI credits."** /
  **"Contact an owner"**.
- AI screen (panel 5 — AI only): breadcrumb **"… · Motir AI"**; title **"Motir AI
  — plans & subscription"** / **"Manage your organization's AI plan — planning &
  hosted agents. Billed separately from your Motir seats, so this screen is AI
  only."**; current-subscription strip **"{tier}"** / **"Active"** / **"{n} credits
  / mo · {left} left · renews {date}"** / **"Manage plan & payment"**; cadence
  toggle **"Monthly"** / **"Annual"** + badge **"Save ~33%"**; menu **"Choose your
  plan"** / **"An org-level monthly credit pool, billed separately from seats. Any
  org can buy it — a paid Motir seat plan is not required. Pro is the recommended
  anchor."**; **"Current"** / **"Recommended"** (Pro) / **"Current plan"** / **"Trial
  used"**; per-tier CTAs **"Choose Starter"** / **"Upgrade to Pro"** / **"Upgrade to
  Max"** / **"Contact sales"**; the annual per-card sublines **"billed annually ·
  ${yr} / yr"** + **"Save ${n}/yr"**, the monthly sublines **"${yr} / yr · Save ${n}
  with annual"**; footer **"Annual billing (the Stripe default) is shown — switch to
  Monthly above to compare. Tax is applied automatically at checkout. Credits are an
  internal usage allotment; the price shown is the AI plan fee, billed by Stripe to
  the {org} organization. Your Motir seats are billed separately — manage them on the
  Motir plan screen."**
- Top-up (panel 5): **"Top up credits"** / **"A one-time purchase on top of your
  plan — added to your balance right away, used after your monthly allotment."**;
  **"Balance {n} credits · {used} of this month's {allotment} allotment used"**;
  bundles **"{n} credits"** / **"${price}"** (1,000/$10 · 5,000/$50 · 10,000/$100 ·
  **"Custom"** / **"× 1,000"**); **"Buy {n} credits — ${total}"**; rate **"$10 per
  1,000 credits · one-time · tax at checkout. Credits are an allotment, not currency
  — this is the price you pay Stripe."**; gate **"Top-ups are available on a paid AI
  plan; the Free trial can't top up (choose a plan above first). Owner-only, like
  every billing action."**
- Seats (panel 6 + the panel-2 preview): **"Scaling bills 1 seat per member — {n}
  today"** / **"{n} × ${seat} = ${total} / mo"** / **"Seats follow membership ·
  prorated automatically"**; review **"Scale up Motir"** / **"One seat per
  organization member — like Jira & Linear."** / **"{n} members → {n} seats"** /
  **"Billed annually — ${aYear} / yr (${aMo} / mo equiv), the default. Charged now,
  prorated for the rest of this cycle. Seats follow your membership automatically —
  add or remove a member and your next invoice adjusts (Stripe proration). Prefer
  monthly? Switch at Checkout to pay ${mTotal} / mo."** / **"Continue to Checkout —
  ${aYear}/yr"** / **"Cancel"**; scaled state (annual default) **"Scaled"** / **"Plan
  fee ${aYear} / yr"** + **"Annual · saves ${save}/yr"** / **"{n} seats billed · 1
  per member"** / **"Billed annually · ${aMo}/mo equiv · renews {date}. … seats
  update automatically as members join or leave."** / **"Manage seats"** / **"Manage
  plan & payment"** / **"Switch to monthly billing"**.
- Paywall: out-of-credits **"Planning is paused — you're out of credits"** /
  **"The {org} organization has used all of this month's {n} {tier} credits, so
  new planning runs are paused. Existing plans stay fully editable."** /
  **"Upgrade plan"** / **"Buy credit top-up · $10/1k"** / **"Renews {date} · or
  upgrade now to keep planning."**; tier-gate **"AI planning is a paid feature"** /
  **"Generate and expand plans with AI by adding a Motir AI plan to the {org}
  organization. Start with 300 free trial credits."** / **"See Motir AI plans"** /
  **"Maybe later"**; member **"AI is out of credits for this org"** / **"Planning is
  paused until the {org} organization's plan is upgraded. Only an organization owner
  can change the plan or buy credits."** / **"Ask an owner to upgrade"**.
- Empty / error: **"You're on the free plan"** / **"The {org} organization has no
  paid subscription yet — Motir is free within its caps and Motir AI is on the
  one-time trial. Add a plan when you're ready to scale."** / **"See plans"**;
  error **"Couldn't load billing"** / **"Something went wrong fetching this
  organization's plan. Your subscription and credits are safe — this is only the
  view. Try again in a moment."** / **"Retry"**.
- Cloud-only note: **"Cloud-only. Every surface here is gated behind MOTIR_CLOUD.
  A self-hosted (GPL-3.0) build shows no billing, no paywall and no caps."**

The full string set is added to the app's locale files (en + zh, the shipped
locale set) by the 8.1.7 / 8.1.8 code subtasks under the new `billing` namespace.
en is the source; keep it byte-stable as other locales are added.
