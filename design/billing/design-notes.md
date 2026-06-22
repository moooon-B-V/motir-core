# Billing · pricing · paywall — design notes

Design reference for the **`billing`** UI area — the **commercial surfaces** that
gate Motir's two billed products. Story 8.1 (Stripe billing + open-core tiering),
subtask **8.1.3** (card **MOTIR-1142**). The asset is the source of truth for the
two motir-core UI code subtasks, both `blocked` behind this design gate
(Principle #13 + the design-reference rule; `notes.html` #31):

| Code subtask                                                          | What it builds from this asset                            |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| **8.1.7 / MOTIR-1148** — billing settings panel + plan/pricing UI    | Panels **1–5** (the settings panel, its states, the storefront) |
| **8.1.8 / MOTIR-1149** — paywall / upgrade prompt at the AI boundary | Panel **6** (out_of_credits 402 + tier-gate + member variant) |

These two cards are linked to MOTIR-1142 as `relates_to` (with the boundary
service **8.1.6 / MOTIR-1147**) — they SPECIFY the flow this design draws; the
design GROUNDS in them and does not invent it. Built FROM the real design system
(`app/globals.css` `--el-*` colour tokens + the `[data-display-style]` shape
tokens + the shipped `components/ui/*` primitives), so the code subtasks compose
the same primitives — no design→code gap.

| Surface                                              | Asset                              | Notes                                                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing settings · pricing storefront · AI paywall** | **`billing.mock.html`** (HTML mockup) | The whole commercial surface, 7 panels: access path · billing settings panel (2 billed lines) · panel states (past_due / trialing / canceled) · role gating · plan/pricing comparison · AI paywall (402 + tier-gate) · empty/loading/error. A `billing.png` full-page export sits beside it (the board-visible face). |

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
  paywall (panel 6) handles it.

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
  → 8.1.5 motir-ai endpoints): the loading skeleton (panel 7b) and the
  fetch-failed error (panel 7c) are real states. Numbers in the mock are
  illustrative.

### Self-host — these surfaces are CLOUD-ONLY

Billing **and** the §4 caps exist **only on cloud**, behind the **`MOTIR_CLOUD`**
flag (decision §6). On a self-hosted (GPL-3.0) build **none of these surfaces
render** — no Billing card, no paywall, no caps; Motir is unbounded and AI
is reached via the self-hoster's own connection. 8.1.7/8.1.8 MUST gate every
surface here behind `MOTIR_CLOUD` (a note states this on panel 7). This flag is
**distinct from** `isAiPlanningConfigured` (which gates whether AI is reachable).

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
  each with a token-only `.meter`. Action: **"Upgrade Motir · $5/seat"**
  (secondary) + a quiet workspace/member/project summary. (On a `scaled` org the
  caps grid is replaced by the seat count + renewal and the action is "Manage".)
- **② Motir AI line (`Card`).** Head: a lavender product glyph (`i-sparkle`),
  title **"Motir AI"**, the subscription status `Pill` (**Active**). Body: a tier
  `Pill` (**"Standard"**) + **"2,000 credits / mo"** + the **plan fee "$25 /
  mo"** (right-aligned); an **allotment meter** with **"1,420 of 2,000 credits
  left"**; **"Renews 1 Jul 2026"** + the credits-are-not-a-bill line. Actions:
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

### Panel 5 — plan / pricing comparison (the storefront, reached from "Change plan")

TWO independent menus (decision §2), under the `… · Change plan` breadcrumb:

- **① Motir** — two `plan` cards: **Free** (`$0/mo`, marked **Current**, the
  caps as a feature list) vs **Scaled** (`$5 / seat / mo`, `$40/yr — save ~33%`,
  caps lifted), per-card CTA → Stripe Checkout for the seat subscription.
- **② Motir AI ladder** — six `plan` cards: **Free** (`$0` once · 300 credits ·
  one-time, "Trial used") / **Starter** (`$5/mo` · 300) / **Standard** (`$25/mo`
  · 2,000, marked **Current**) / **Pro** (`$75/mo` · 8,000, `i-zap` accent,
  marked **Recommended** — the anchor tier) / **Max** (`$150/mo` · 30,000,
  `i-crown` accent) / **Enterprise** (Custom, "Contact sales"). Each card: name,
  **price** (serif), credit **allotment**, a `i-check` feature list (off-features
  `i-x`, faint), and a per-tier CTA → Checkout. The current plan is accent-bordered
  + disabled CTA; the recommended Pro card is accent-bordered with a "Recommended"
  `Pill`. A footer `note` reiterates annual-saves-~33%, tax-at-checkout and
  credits-vs-price.

### Panel 6 — paywall at the AI boundary (8.1.8)

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

### Panel 7 — empty / loading / error

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
- **`EmptyState` / `ErrorState` family** — the member gate (4b), the tier-gate +
  member paywall (6b/6c), empty/error (7a/7c).
- **`Skeleton`** — the loading panel (7b).
- **Meter / bar (token-only)** — the allotment meter + the free-cap meters are
  plain token-styled `div`s (radius + tint), no charting lib, no image — the same
  `.meter` pattern as `ai-usage`.

## Colour roles (`--el-*` — palette, not grey-only · finding #54)

| Element                                       | Token                                                        | Why                                                                  |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| **Plan price / credit figures (serif)**       | `--el-text` · unit/`per` in `--el-text-muted`                | The primary numbers; the unit/price-cadence reads quiet.            |
| **Tier chip (Standard / Pro / …)**            | `--el-tint-lavender` bg + `--el-text-strong`                 | The AI plan tier — brand-purple family, matches the org avatar.     |
| **Status: Active**                            | `--el-tint-mint` bg + `--el-text-strong`, `i-check`          | Healthy / paid — success family.                                    |
| **Status: Free trial / trialing**             | `--el-tint-sky` bg + `--el-text-strong`, `i-sparkle`         | Informational, not yet paid — the info/try family.                  |
| **Status: Past due (dunning)**                | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning` | Warning, recoverable — keep-through-grace, not danger.           |
| **Status: Canceled**                          | `--el-tint-rose` bg + `--el-text-strong`, `i-x`              | Ended / dropped — danger family (but data retained).                |
| **Motir-state: Free / View-only / readonly**  | neutral `Pill` (`--el-surface` + `--el-text-secondary`)      | Genuinely neutral state metadata.                                   |
| **Allotment meter fill (healthy)**            | `--el-accent`                                                | Primary "credits remaining" share.                                  |
| **Allotment meter fill (low / past_due)**     | `--el-warning`                                               | Low-balance / dunning variant.                                      |
| **Free-cap meters**                           | `--el-accent`                                                | Usage-against-cap share.                                            |
| **Dunning / warning banner**                  | `--el-tint-yellow` bg + `--el-text-strong`, icon `--el-warning` | Warning hue in the BANNER tint, not the page (finding #35).      |
| **Canceled banner**                           | `--el-tint-rose` bg + `--el-text-strong`, icon `--el-danger-text` | Ended-plan notice — danger tint in the banner only.            |
| **Info / tax / cloud-only notes**             | `--el-surface-soft` dashed (`--el-border-strong`) · `i-info` | Quiet, dashed advisory — the passive-affordance shape.              |
| **Out-of-credits / paused icon**              | `--el-tint-yellow` + `--el-warning`                          | The paused state — warning, not danger (nothing is broken).         |
| **Tier-gate / lock-gate icon**                | `--el-tint-lavender` / `--el-surface` + `--el-text-strong`   | "AI is paid" / "ask your owner" — gate, not error.                  |
| **Error icon tint**                           | `--el-tint-rose` + `--el-danger-text`                        | Fetch-error state (panel 7c).                                       |
| **Feature-list check / off**                  | `i-check` `--el-success` · off `i-x` `--el-text-faint`       | Included vs not — palette green, not grey-only.                     |
| **Pro / Max accent glyph**                    | `--el-accent-on-surface` (`i-zap` / `i-crown`)               | The heavier paid tiers carry an accent glyph (accent AS icon).      |
| **Current-plan card border**                  | `--el-accent`                                                | Marks the org's current plan in the storefront.                     |
| **Primary CTAs / Upgrade**                    | `--el-accent` + `--el-accent-text`                           | Upgrade / Change-plan / Resubscribe — the conversion action.        |
| **Cross-link (View Usage & cost)**            | `--el-link`                                                  | Quiet inline navigation to the sibling dashboard.                   |
| **Payment card-brand chip**                   | `--el-tint-sky` + `--el-text-strong`                         | The Stripe payment-method affordance.                               |
| Text / surfaces / borders                     | `--el-text*`, `--el-surface*`, `--el-border*`                | Standard element tokens — never Tier-0 `--color-*`.                 |

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
- Storefront: **"Choose your plans"** / **"Motir and Motir AI are billed
  separately — buy either, both or neither. A small team within the free caps
  pays nothing for Motir and only for the AI it opts into."**; **"① Motir"**
  / **"The PM tool — free for small teams, $5/seat only when you scale."**;
  **"② Motir AI — planning & agents"** / **"An org-level monthly credit pool. Any
  org can buy it — paid Motir isn't required."**; **"Current"** / **"Recommended"**
  (Pro) / **"Your current plan"** / **"Current plan"** / **"Trial used"**; per-tier
  CTAs **"Upgrade Motir"** / **"Choose Starter"** / **"Upgrade to Pro"** / **"Upgrade
  to Max"** / **"Contact sales"**; the Scaled card carries **"or $40 / seat / yr —
  save ~33%"**; footer **"Prices shown monthly; choosing annual billing saves ~33%
  (the Stripe annual default). Tax is calculated automatically at checkout. Credits
  are an internal usage allotment; the price above is the plan fee, billed by
  Stripe to the {org} organization."**
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
