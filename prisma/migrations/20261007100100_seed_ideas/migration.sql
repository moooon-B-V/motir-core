-- Story MOTIR-7662 · MOTIR-7674 — seed the idea store with today's 15 ideas
-- and the first curated tag vocabulary.
--
-- SOURCE: moooon-B-V/motir-marketing PR #81, branch `motir-co-vibe-the-project`
-- at `ad6063e`, `messages/en.json` → `ideas.items` (6 `motir_buys`) and
-- `ideas.more.ideas` (9 `direction`), read on 2026-10-06. The text is copied
-- VERBATIM: it is the owner's published copy, and this is a move, not an edit.
-- `docs/ideas-seed.md` is the disposition table — every source field and where
-- it went; the only field dropped is `mark` (presentation, derived from the
-- category on motir.co).
--
-- FORWARD-ONLY AND IDEMPOTENT. Every tag and idea is `ON CONFLICT (slug) DO
-- NOTHING`, and an idea's evidence and tag assignments are written only when
-- THIS statement created the idea — so a re-run, or an idea already edited (or
-- retired, or deleted and re-added) in production, is never overwritten. Not
-- environment-guarded: the ideas are Motir's own content and belong in every
-- environment.
--
-- ONE STATEMENT (a single DO block), so the same file can be re-applied by a
-- test through one raw execute and prove the idempotency claim.
--
-- SOURCE DATES are the first day of the period the source name states:
-- "January 2026" → 2026-01-01. Two sources name no month: "Fall 2026" (Y
-- Combinator's Requests for Startups) → 2026-09-01, the season's first month;
-- "2025" alone (Gallup and PetSmart Charities) → 2025-01-01, that year's
-- January 1st.
--
-- `added_at` is staggered by a second per idea, newest first in source order,
-- so the public list (kind, then newest) reproduces the page's order today.
DO $seed$
DECLARE
  created TEXT;
BEGIN
  INSERT INTO "idea_tag" ("id", "slug", "label", "description") VALUES
    ('seed-tag-b2b-saas', 'b2b-saas', 'B2B software', 'The customer is a software company or a B2B software team.'),
    ('seed-tag-startups', 'startups', 'Startups', 'Built for an early-stage company without a department for the job yet.'),
    ('seed-tag-smb', 'smb', 'Small businesses', 'For businesses below enterprise size, which the funded players in the space do not serve.'),
    ('seed-tag-consumer', 'consumer', 'Consumers', 'Paid for by an individual or a family, not by an employer.'),
    ('seed-tag-developer-tools', 'developer-tools', 'Developer tools', 'Used by engineers, or lives inside their workflow: code, APIs, pull requests.'),
    ('seed-tag-compliance', 'compliance', 'Compliance', 'The demand comes from a legal, regulatory or audit duty, not a preference.'),
    ('seed-tag-eu-ai-act', 'eu-ai-act', 'EU AI Act', 'Driven by an obligation in the EU AI Act.'),
    ('seed-tag-ai-agents', 'ai-agents', 'AI agents', 'The product acts on the work (drafts, files, opens a pull request) rather than only answering.'),
    ('seed-tag-pricing-and-billing', 'pricing-and-billing', 'Pricing and billing', 'About money: what something costs, what to charge, or how a customer pays.'),
    ('seed-tag-vertical-saas', 'vertical-saas', 'Vertical software', 'Software for one industry (stores, clinics) rather than a business function.'),
    ('seed-tag-healthcare', 'healthcare', 'Healthcare', 'Medical or veterinary care, where a mistake harms someone.'),
    ('seed-tag-education', 'education', 'Education', 'Teaching or coaching a person toward a skill.'),
    ('seed-tag-caregiving', 'caregiving', 'Caregiving', 'Looking after a dependent family member.'),
    ('seed-tag-yc-rfs', 'yc-rfs', 'On YC''s request list', 'Named on Y Combinator''s Requests for Startups, a public signal that the space is wanted.')
  ON CONFLICT ("slug") DO NOTHING;

  -- 1. ideas.items · An AI legal team for software companies
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-an-ai-legal-team-for-software-companies', 'an-ai-legal-team-for-software-companies',
    'An AI legal team for software companies',
    'Terms, privacy policies, data processing agreements and the record of every vendor that touches customer data, drafted, kept current and reviewed by a lawyer.',
    'motir_buys', 'legal',
    ARRAY['Drafts and updates terms, privacy policies and data processing agreements as the product changes', 'Reviews vendor and customer contracts and flags what needs a lawyer', 'Tracks new rules, like the EU AI Act, and says what each one changes for you']::TEXT[],
    NULL,
    'Every model provider Motir adds needs a data processing agreement and a recorded legal basis for sending customer data to it. Today that is slow, manual work.',
    'Every software company that handles customer data, which is all of them.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '0 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('b2b-saas', 'compliance', 'eu-ai-act', 'ai-agents');
  END IF;

  -- 2. ideas.items · An AI finance team for startups
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-an-ai-finance-team-for-startups', 'an-ai-finance-team-for-startups',
    'An AI finance team for startups',
    'Price the plans, bill for usage, file the taxes and pay the vendors, from one place that understands what each customer actually costs.',
    'motir_buys', 'finance',
    ARRAY['Sets plan prices from real costs: model calls, machine time, storage', 'Reconciles usage billing and files sales tax and VAT in every country you sell to', 'Pays vendors, tracks runway and closes the books each month']::TEXT[],
    NULL,
    'Motir resells model calls and machine minutes at a margin. Pricing a plan means knowing the cost of every credit, in every currency, after tax.',
    'Every usage-priced software startup, from its first invoice to its first audit.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '1 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('startups', 'pricing-and-billing', 'b2b-saas');
  END IF;

  -- 3. ideas.items · AI security and compliance, from the evidence
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-ai-security-and-compliance-from-the-evidence', 'ai-security-and-compliance-from-the-evidence',
    'AI security and compliance, from the evidence',
    'SOC 2 and ISO 27001 evidence collected from the code, the cloud and the project itself, and security questionnaires answered from it.',
    'motir_buys', 'security_compliance',
    ARRAY['Collects evidence from repositories, cloud accounts and the project''s history', 'Answers customer security questionnaires from that evidence, with sources', 'Watches for drift and opens a work item when a control slips']::TEXT[],
    NULL,
    'A business customer asks for a security review before it signs. Every answer is somewhere in Motir''s code and records, and finding it takes days we would rather spend building.',
    'Every software company selling to a business big enough to ask.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '2 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('b2b-saas', 'compliance');
  END IF;

  -- 4. ideas.items · AI support that knows the product
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-ai-support-that-knows-the-product', 'ai-support-that-knows-the-product',
    'AI support that knows the product',
    'Answers customers from the docs, the code and the live state of the product, and turns a real bug into a planned work item instead of a reply.',
    'motir_buys', 'customer_support',
    ARRAY['Answers from documentation, code and the customer''s own account', 'Hands a real defect to the engineering team as a planned work item, with the evidence', 'Learns from every answer a person corrects']::TEXT[],
    NULL,
    'Motir''s users ask about agents, models, credits and repositories. A good answer needs the code and the account, not a help-center search.',
    'Every developer-tool and B2B software company with more customers than support staff.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '3 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('b2b-saas', 'developer-tools', 'ai-agents');
  END IF;

  -- 5. ideas.items · AI localization that keeps up with the product
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-ai-localization-that-keeps-up-with-the-product', 'ai-localization-that-keeps-up-with-the-product',
    'AI localization that keeps up with the product',
    'Translates the interface, the docs and the emails as they change, keeps every term consistent, and has a native speaker review what matters.',
    'motir_buys', 'localization',
    ARRAY['Translates each change as it lands, not in a yearly project', 'Keeps a glossary so a term means one thing everywhere', 'Sends the risky strings, legal text and pricing to a native reviewer']::TEXT[],
    NULL,
    'Motir ships in English and Chinese, and every release changes hundreds of strings. Keeping both right by hand does not scale to a third language.',
    'Every software company that wants customers outside its home country.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '4 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('b2b-saas', 'ai-agents');
  END IF;

  -- 6. ideas.items · AI growth for B2B software
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-ai-growth-for-b2b-software', 'ai-growth-for-b2b-software',
    'AI growth for B2B software',
    'Turns what a team ships into launch posts, changelog announcements, comparison pages and search-ready docs, and measures what brings customers.',
    'motir_buys', 'growth_marketing',
    ARRAY['Writes the announcement for each release from the work that shipped', 'Builds and refreshes the pages people search for before they buy', 'Shows which pages and posts bring customers, not just visitors']::TEXT[],
    NULL,
    'Motir ships every day, in public. Turning that into posts and pages people find takes a marketing team we do not have.',
    'Every B2B software company that ships faster than it can tell anyone.',
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '5 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('b2b-saas', 'startups');
  END IF;

  -- 7. ideas.more.ideas · Make a store visible to AI shoppers
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-make-a-store-visible-to-ai-shoppers', 'make-a-store-visible-to-ai-shoppers',
    'Make a store visible to AI shoppers',
    'Gets a small store''s products found and recommended by the AI assistants people now shop through, and shows how often each product is picked.',
    'direction', 'ecommerce',
    ARRAY[]::TEXT[],
    'The funded players sell to large brands and big catalogs. Millions of small stores have nothing yet, and the window is short.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '6 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'Traffic from AI assistants to US retail sites rose 693% in the 2025 holiday season and converted 31% better than other traffic.',
      'Adobe Analytics, via Digital Commerce 360, January 2026',
      'https://www.digitalcommerce360.com/2026/01/13/generative-ai-online-holiday-shopping-traffic-2025/',
      DATE '2026-01-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('smb', 'vertical-saas');
  END IF;

  -- 8. ideas.more.ideas · Stop returns before they happen
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-stop-returns-before-they-happen', 'stop-returns-before-they-happen',
    'Stop returns before they happen',
    'Spots the order bought in three sizes to send two back, answers the fit question before checkout, and scores each return for fraud.',
    'direction', 'ecommerce',
    ARRAY[]::TEXT[],
    'Return platforms handle the return once it starts. Preventing it, for stores below enterprise size, is barely served.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '7 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'Shoppers were expected to return $849.9 billion of goods in 2025, 19.3% of online sales, and 9% of returns are fraudulent.',
      'National Retail Federation and Happy Returns, October 2025',
      'https://nrf.com/media-center/press-releases/consumers-expected-to-return-nearly-850-billion-in-merchandise-in-2025',
      DATE '2025-10-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('smb', 'vertical-saas');
  END IF;

  -- 9. ideas.more.ideas · APIs that update their customers' code
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-apis-that-update-their-customers-code', 'apis-that-update-their-customers-code',
    'APIs that update their customers'' code',
    'When an API makes a breaking change, the provider opens the pull request that migrates each customer''s code, instead of sending an email.',
    'direction', 'ai_infrastructure',
    ARRAY[]::TEXT[],
    'Dependency bots only bump version numbers, and SDK generators don''t touch customer code. Agents can now edit unfamiliar code well enough to open the pull request.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '8 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'On Y Combinator''s Fall 2026 Requests for Startups: API providers shouldn''t just announce changes; they should apply them.',
      'Y Combinator, Requests for Startups, Fall 2026',
      'https://www.ycombinator.com/rfs',
      DATE '2026-09-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('developer-tools', 'ai-agents', 'yc-rfs');
  END IF;

  -- 10. ideas.more.ideas · AI cost by feature and by customer
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-ai-cost-by-feature-and-by-customer', 'ai-cost-by-feature-and-by-customer',
    'AI cost by feature and by customer',
    'Splits the AI bill by feature and by customer, sets budgets, and shows finance and engineering the margin of every plan in one view.',
    'direction', 'ai_infrastructure',
    ARRAY[]::TEXT[],
    'Cloud cost tools are built around the cloud bill, and AI observability tools are built for developers. Neither gives finance a margin per feature.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '9 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      '79% of finance leaders report AI cost overruns, and only 15% can calculate the return on AI spend without significant bottlenecks.',
      'DoiT and Sapio Research, survey of 500 finance leaders, February 2026',
      'https://www.doit.com/blog/ai-spending-survey',
      DATE '2026-02-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('pricing-and-billing', 'developer-tools');
  END IF;

  -- 11. ideas.more.ideas · The AI transparency kit
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-the-ai-transparency-kit', 'the-ai-transparency-kit',
    'The AI transparency kit',
    'A drop-in kit that tells users they''re talking to an AI, marks generated content in a machine-readable way and labels deepfakes, as the EU now requires.',
    'direction', 'ai_infrastructure',
    ARRAY[]::TEXT[],
    'Content-marking vendors serve enterprises or one platform. A small app maker has no simple way to comply before the deadline.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '10 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'The EU AI Act''s Article 50 transparency duties apply from 2 August 2026, with systems already on the market given until 2 December 2026, and fines of up to €15 million or 3% of worldwide turnover.',
      'Jones Walker, AI Law Blog, July 2026',
      'https://www.joneswalker.com/en/insights/blogs/ai-law-blog/yes-august-2-still-matters-the-eu-approved-a-high-risk-ai-delay-but-most-trans.html?id=102nbon',
      DATE '2026-07-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('compliance', 'eu-ai-act', 'developer-tools', 'smb');
  END IF;

  -- 12. ideas.more.ideas · A first tutor for young children
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-a-first-tutor-for-young-children', 'a-first-tutor-for-young-children',
    'A first tutor for young children',
    'A voice tutor at home that teaches four-to-eight-year-olds to read, write and count, one child at a time, at the child''s own pace.',
    'direction', 'personal_growth',
    ARRAY[]::TEXT[],
    'Ello, the funded AI tutor for this age, teaches reading only, and the best-known AI tutors are built for schools, not homes.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '11 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'On Y Combinator''s Fall 2026 Requests for Startups as "The Primer", noting the cost of the AI per child is falling about ten times a year.',
      'Y Combinator, Requests for Startups, Fall 2026',
      'https://www.ycombinator.com/rfs',
      DATE '2026-09-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('consumer', 'education', 'yc-rfs');
  END IF;

  -- 13. ideas.more.ideas · A career coach for people who pay for themselves
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-a-career-coach-for-people-who-pay-for-themselves', 'a-career-coach-for-people-who-pay-for-themselves',
    'A career coach for people who pay for themselves',
    'Coaching and practice conversations for the job you want next, for the many workers whose employer won''t pay for training.',
    'direction', 'personal_growth',
    ARRAY[]::TEXT[],
    'AI coaching is sold only to employers, and learning platforms sell courses, not coaching. Nobody serves the person who pays for themselves.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '12 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      'Valence raised a $50 million Series B for AI coaching, after more than a million coaching conversations, showing AI coaching works when employers buy it.',
      'Valence, September 2025',
      'https://www.valence.co/blog/series-b-press-release',
      DATE '2025-09-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('consumer', 'education');
  END IF;

  -- 14. ideas.more.ideas · Treatment options for vet clinics
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-treatment-options-for-vet-clinics', 'treatment-options-for-vet-clinics',
    'Treatment options for vet clinics',
    'During the exam, turns one diagnosis into two or three priced treatment plans with a payment plan attached, so the pet gets care the owner can afford.',
    'direction', 'pets',
    ARRAY[]::TEXT[],
    'Vet AI tools write the visit notes and practice software books the visits. None turns a case into priced options.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '13 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      '94% of vets say cost stops recommended care, and 81% say they offer alternatives, yet 73% of pet owners say they were never offered a cheaper plan.',
      'Gallup and PetSmart Charities, survey of 933 vets, 2025',
      'https://news.gallup.com/poll/700115/veterinarians-say-cost-main-driver-declined-care.aspx',
      DATE '2025-01-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('smb', 'vertical-saas', 'healthcare', 'pricing-and-billing');
  END IF;

  -- 15. ideas.more.ideas · A care team app for families
  created := NULL;
  INSERT INTO "idea" ("id", "slug", "title", "pitch", "kind", "category", "capabilities", "gap", "why_motir", "who_else", "added_at", "updated_at")
  VALUES ('seed-idea-a-care-team-app-for-families', 'a-care-team-app-for-families',
    'A care team app for families',
    'Shares medicines, tasks and appointments across the family looking after a parent, and explains each care task in plain words.',
    'direction', 'family_care',
    ARRAY[]::TEXT[],
    'Care coordination is sold to employers as a benefit, or comes with paid carers. The free apps families use are basic.',
    NULL,
    NULL,
    TIMESTAMP '2026-10-07 00:00:00' - INTERVAL '14 seconds', CURRENT_TIMESTAMP)
  ON CONFLICT ("slug") DO NOTHING
  RETURNING "id" INTO created;
  IF created IS NOT NULL THEN
    INSERT INTO "idea_evidence" ("id", "idea_id", "position", "claim", "source_name", "url", "source_date")
    VALUES (created || '-ev-0', created, 0,
      '63 million Americans are family caregivers, about 45% more than in 2015. More than half do medical or nursing tasks, and only 20% have been trained.',
      'AARP and the National Alliance for Caregiving, July 2025',
      'https://www.aarp.org/press/releases/2025-07-24-new-report-reveals-crisis-point-for-americas-63-million-family-caregivers.html',
      DATE '2025-07-01');
    INSERT INTO "idea_tag_assignment" ("idea_id", "tag_id")
    SELECT created, "id" FROM "idea_tag" WHERE "slug" IN ('consumer', 'caregiving', 'healthcare');
  END IF;

END
$seed$;
