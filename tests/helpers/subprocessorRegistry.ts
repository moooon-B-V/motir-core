// MOTIR-3631 — the SIGNATURES that tie `content/legal/subprocessors.md` to code.
//
// The page is a published legal representation whose rows are, for the most
// part, facts about this repository: a dependency in `package.json`, an outbound
// host in application code. This module says which fact belongs to which vendor,
// so `tests/legal/subprocessor-list-guard.test.ts` can hold the two together.
//
// ⚠️ THE PAGE IS THE SOURCE OF TRUTH FOR WHAT WE DISCLOSE. This file is the
// source of truth for WHAT COUNTS AS EVIDENCE. When they disagree the guard
// fails and a person decides which was wrong — the guard never edits the page.

/** A vendor, and the repository facts that prove it receives data. */
export interface VendorSignature {
  /** The label as it appears in the FIRST bolded span of the page's table row. */
  readonly vendor: string;
  /** Dependency names in `package.json` whose presence means this vendor is live. */
  readonly packages?: readonly string[];
  /** Outbound hosts in `lib/` or `app/` whose presence means this vendor is live. */
  readonly hosts?: readonly string[];
}

/**
 * ⚠️ A SIGNATURE IS EVIDENCE OF EGRESS, NOT OF INTENT.
 *
 * `api.stripe.com` is Stripe's real API host and is listed. `checkout.stripe.com`
 * and `billing.stripe.com` are NOT: they are synthetic session URLs the E2E
 * billing mock returns, and nothing leaves localhost. They live in
 * `NOT_A_VENDOR_HOST` with that reason.
 *
 * The distinction is the whole reason this file exists rather than a regex over
 * hostnames. A host string in the tree is not proof that anything is sent to it,
 * and a guard that assumed otherwise would have flagged Stripe as a live
 * subprocessor on the day the page correctly said it receives nothing.
 */
export const VENDOR_SIGNATURES: readonly VendorSignature[] = [
  { vendor: 'Fly.io', hosts: ['fly.io', 'api.machines.dev'] },
  { vendor: 'Tigris', packages: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'] },
  { vendor: 'Inngest', packages: ['inngest'] },
  { vendor: 'Resend', hosts: ['api.resend.com'] },
  { vendor: 'Sentry', packages: ['@sentry/nextjs'] },
  { vendor: 'Google', hosts: ['accounts.google.com', 'oauth2.googleapis.com'] },
  { vendor: 'Plausible', hosts: ['plausible.io'] },
  {
    vendor: 'GitHub',
    hosts: [
      'api.github.com',
      'github.com',
      'codeload.github.com',
      'token.actions.githubusercontent.com',
      'ghcr.io',
    ],
  },
  { vendor: 'GitLab', hosts: ['gitlab.com'] },
  { vendor: 'Atlassian / Jira', hosts: ['api.atlassian.com', 'auth.atlassian.com'] },
  { vendor: 'Linear', hosts: ['api.linear.app', 'linear.app'] },
  { vendor: 'Plane', hosts: ['api.plane.so', 'app.plane.so'] },
  { vendor: 'Stripe', packages: ['stripe'], hosts: ['api.stripe.com'] },
];

/**
 * Hosts that appear in `lib/` or `app/` and are NOT a subprocessor, each with
 * the reason. Every entry is asserted to STILL MATCH something — an entry that
 * stops describing the tree fails the guard rather than rotting here.
 */
export const NOT_A_VENDOR_HOST: Readonly<Record<string, string>> = {
  // Ourselves.
  'motir.co': 'our own domain',
  'www.motir.co': 'our own marketing domain',
  'app.motir.co': 'the hosted service itself',

  // Synthetic URLs returned by the E2E billing mock. Nothing leaves localhost —
  // see `lib/test-billing-mock.ts`. Stripe's REAL host is in VENDOR_SIGNATURES,
  // so Stripe going live still trips this guard.
  'checkout.stripe.com': 'E2E billing mock fixture; nothing leaves localhost',
  'billing.stripe.com': 'E2E billing mock fixture; nothing leaves localhost',

  // Placeholders in copy, examples and fixtures — never fetched.
  'acme.atlassian.net': 'documentation placeholder in importer copy',
  'your-domain.atlassian.net': 'documentation placeholder in importer copy',
  'example.com': 'RFC 2606 example domain, used in fixtures',
  'evil.example': 'negative-case fixture for URL validation',
  'motir.example.com': 'documentation placeholder',
  'device-handoff.invalid': 'RFC 2606 invalid TLD, used in a fixture',

  // Documentation we LINK to. A link is rendered for a human to click; the
  // server never requests it, so no data of ours reaches these.
  'docs.claude.com': 'documentation link shown to the user',
  'developers.openai.com': 'documentation link shown to the user',
  'developers.google.com': 'documentation link shown to the user',
  'code.visualstudio.com': 'documentation link shown to the user',
  'cursor.com': 'documentation link shown to the user',
  'modelcontextprotocol.io': 'documentation link shown to the user',

  // A vocabulary namespace, not an endpoint.
  'schema.org': 'JSON-LD vocabulary namespace; never requested',
};

/**
 * ⚠️ VENDORS THIS GUARD CANNOT SEE, and why — the boundary, stated so that a
 * green run is not mistaken for a verified page.
 *
 * Each of these is on the page and is real. None of them leaves a trace this
 * guard can read, so their rows are held by the human re-run of the page's own
 * method section and by nothing else.
 */
export const INVISIBLE_TO_THIS_GUARD: Readonly<Record<string, string>> = {
  Neon: 'reached over the Postgres wire protocol via DATABASE_URL, not an HTTPS host or an SDK',
  'motir-ai': 'reached at MOTIR_AI_URL, a deployment secret rather than a literal in the tree',
  OpenAI: 'reached THROUGH the gateway; motir-core never names it',
  Brave: 'reached THROUGH the gateway; motir-core never names it',
  'Spaceship (Spacemail)': 'a mailbox, with no code path at all',
};
