# The idea store's seed — disposition table

Story MOTIR-7662 · MOTIR-7674. The migration
`prisma/migrations/20261007100100_seed_ideas/migration.sql` moves the 15 ideas
motir.co shows today out of `messages/en.json` and into the store. This table is
what keeps that move honest: every source entry, every source field, and where
it went. **Nothing is dropped silently — the only dropped field is `mark`.**

**Source:** moooon-B-V/motir-marketing PR #81, branch `motir-co-vibe-the-project`
at `ad6063e`, `messages/en.json`, read on 2026-10-06. Text is copied verbatim.

## Field mapping

### `ideas.items` → `kind = motir_buys` (6)

| Source field | Destination                   | Note                                                                                                                                              |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tab`        | `category`                    | Legal→`legal`, Finance→`finance`, Security→`security_compliance`, Support→`customer_support`, Languages→`localization`, Growth→`growth_marketing` |
| `title`      | `title`, and `slug` (derived) | slug = the title lower-cased, apostrophes removed, other runs of non-alphanumerics as `-`                                                         |
| `pitch`      | `pitch`                       | verbatim                                                                                                                                          |
| `does[]`     | `capabilities[]`              | verbatim, in order                                                                                                                                |
| `need`       | `whyMotir`                    | verbatim                                                                                                                                          |
| `who`        | `whoElse`                     | verbatim                                                                                                                                          |
| —            | `gap`, `whyNow`               | null; no evidence rows (none exist in the source)                                                                                                 |

### `ideas.more.ideas` → `kind = direction` (9)

| Source field | Destination                                           | Note                                                                                                                                     |
| ------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `category`   | `category`                                            | E-commerce→`ecommerce`, AI infrastructure→`ai_infrastructure`, Personal growth→`personal_growth`, Pets→`pets`, Family care→`family_care` |
| `title`      | `title`, and `slug` (derived)                         | as above                                                                                                                                 |
| `pitch`      | `pitch`                                               | verbatim                                                                                                                                 |
| `evidence`   | `IdeaEvidence.claim` (position 0)                     | verbatim                                                                                                                                 |
| `sourceName` | `IdeaEvidence.sourceName`, and `sourceDate` (derived) | the first day of the stated month; see the dates below                                                                                   |
| `url`        | `IdeaEvidence.url`                                    | verbatim                                                                                                                                 |
| `gap`        | `gap`                                                 | verbatim                                                                                                                                 |
| `mark`       | **dropped: presentation**                             | a visual mark motir.co derives from the category                                                                                         |
| —            | `capabilities`, `whyNow`, `whyMotir`, `whoElse`       | empty / null                                                                                                                             |

## The 15 entries

| #   | Source                | Title                                            | Slug                                               | Category              | Source date                               | Tags                                                        |
| --- | --------------------- | ------------------------------------------------ | -------------------------------------------------- | --------------------- | ----------------------------------------- | ----------------------------------------------------------- |
| 1   | `ideas.items[0]`      | An AI legal team for software companies          | `an-ai-legal-team-for-software-companies`          | `legal`               | —                                         | `b2b-saas`, `compliance`, `eu-ai-act`, `ai-agents`          |
| 2   | `ideas.items[1]`      | An AI finance team for startups                  | `an-ai-finance-team-for-startups`                  | `finance`             | —                                         | `startups`, `pricing-and-billing`, `b2b-saas`               |
| 3   | `ideas.items[2]`      | AI security and compliance, from the evidence    | `ai-security-and-compliance-from-the-evidence`     | `security_compliance` | —                                         | `b2b-saas`, `compliance`                                    |
| 4   | `ideas.items[3]`      | AI support that knows the product                | `ai-support-that-knows-the-product`                | `customer_support`    | —                                         | `b2b-saas`, `developer-tools`, `ai-agents`                  |
| 5   | `ideas.items[4]`      | AI localization that keeps up with the product   | `ai-localization-that-keeps-up-with-the-product`   | `localization`        | —                                         | `b2b-saas`, `ai-agents`                                     |
| 6   | `ideas.items[5]`      | AI growth for B2B software                       | `ai-growth-for-b2b-software`                       | `growth_marketing`    | —                                         | `b2b-saas`, `startups`                                      |
| 7   | `ideas.more.ideas[0]` | Make a store visible to AI shoppers              | `make-a-store-visible-to-ai-shoppers`              | `ecommerce`           | 2026-01-01                                | `smb`, `vertical-saas`                                      |
| 8   | `ideas.more.ideas[1]` | Stop returns before they happen                  | `stop-returns-before-they-happen`                  | `ecommerce`           | 2025-10-01                                | `smb`, `vertical-saas`                                      |
| 9   | `ideas.more.ideas[2]` | APIs that update their customers' code           | `apis-that-update-their-customers-code`            | `ai_infrastructure`   | 2026-09-01 (no month: "Fall" → September) | `developer-tools`, `ai-agents`, `yc-rfs`                    |
| 10  | `ideas.more.ideas[3]` | AI cost by feature and by customer               | `ai-cost-by-feature-and-by-customer`               | `ai_infrastructure`   | 2026-02-01                                | `pricing-and-billing`, `developer-tools`                    |
| 11  | `ideas.more.ideas[4]` | The AI transparency kit                          | `the-ai-transparency-kit`                          | `ai_infrastructure`   | 2026-07-01                                | `compliance`, `eu-ai-act`, `developer-tools`, `smb`         |
| 12  | `ideas.more.ideas[5]` | A first tutor for young children                 | `a-first-tutor-for-young-children`                 | `personal_growth`     | 2026-09-01 (no month: "Fall" → September) | `consumer`, `education`, `yc-rfs`                           |
| 13  | `ideas.more.ideas[6]` | A career coach for people who pay for themselves | `a-career-coach-for-people-who-pay-for-themselves` | `personal_growth`     | 2025-09-01                                | `consumer`, `education`                                     |
| 14  | `ideas.more.ideas[7]` | Treatment options for vet clinics                | `treatment-options-for-vet-clinics`                | `pets`                | 2025-01-01 (year only → January 1st)      | `smb`, `vertical-saas`, `healthcare`, `pricing-and-billing` |
| 15  | `ideas.more.ideas[8]` | A care team app for families                     | `a-care-team-app-for-families`                     | `family_care`         | 2025-07-01                                | `consumer`, `caregiving`, `healthcare`                      |

## The tag vocabulary (14)

Every tag carries a stated reason (its `description`), and every idea carries one
to four of them.

| Slug                  | Label                | Why it exists                                                                                  | Ideas |
| --------------------- | -------------------- | ---------------------------------------------------------------------------------------------- | ----- |
| `b2b-saas`            | B2B software         | The customer is a software company or a B2B software team.                                     | 6     |
| `startups`            | Startups             | Built for an early-stage company without a department for the job yet.                         | 2     |
| `smb`                 | Small businesses     | For businesses below enterprise size, which the funded players in the space do not serve.      | 4     |
| `consumer`            | Consumers            | Paid for by an individual or a family, not by an employer.                                     | 3     |
| `developer-tools`     | Developer tools      | Used by engineers, or lives inside their workflow: code, APIs, pull requests.                  | 4     |
| `compliance`          | Compliance           | The demand comes from a legal, regulatory or audit duty, not a preference.                     | 3     |
| `eu-ai-act`           | EU AI Act            | Driven by an obligation in the EU AI Act.                                                      | 2     |
| `ai-agents`           | AI agents            | The product acts on the work (drafts, files, opens a pull request) rather than only answering. | 4     |
| `pricing-and-billing` | Pricing and billing  | About money: what something costs, what to charge, or how a customer pays.                     | 3     |
| `vertical-saas`       | Vertical software    | Software for one industry (stores, clinics) rather than a business function.                   | 3     |
| `healthcare`          | Healthcare           | Medical or veterinary care, where a mistake harms someone.                                     | 2     |
| `education`           | Education            | Teaching or coaching a person toward a skill.                                                  | 2     |
| `caregiving`          | Caregiving           | Looking after a dependent family member.                                                       | 1     |
| `yc-rfs`              | On YC's request list | Named on Y Combinator's Requests for Startups, a public signal that the space is wanted.       | 2     |

## Idempotency

Each tag and idea is inserted `ON CONFLICT (slug) DO NOTHING`; evidence and tag
assignments are written only for an idea that statement created. A re-run, a
replay on a fresh database, or a production idea already edited, retired or
re-added through the console or the `motir-ideas` skill is never overwritten.
`tests/ideas/ideasSeed.test.ts` re-applies the file and asserts nothing changed.
