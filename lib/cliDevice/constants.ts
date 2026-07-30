// The device-authorization grant's fixed parameters (Story MOTIR-1863 · Subtask
// MOTIR-1865). Every value here is DECIDED in `docs/decisions/cli-login.md` — this
// module is where the decision becomes code, so the plugin config
// (`lib/auth/index.ts`), the service, and the tests all read ONE source rather
// than three literals that can drift apart.
//
// Deliberately a dependency-free leaf (constants + two pure string helpers): it is
// imported by `lib/auth/index.ts`, which sits at the bottom of the import graph, so
// anything heavier here would risk a cycle.

/**
 * The `client_id` the CLI presents, and the ONLY one this deployment opens grants
 * for (the plugin's `validateClient`). A pinned identifier means an unrelated
 * caller cannot open device grants against a Motir install; it is not a secret and
 * is not authentication — the browser approval is.
 *
 * `packages/cli` hardcodes the same literal (it cannot import from the app root —
 * separate package, separate build). Changing it here is a CLI-visible contract
 * change: bump both, or old binaries get `invalid_grant`.
 */
export const CLI_CLIENT_ID = 'motir-cli';

/**
 * Device/user-code lifetime, as a Better-Auth time string. 15m rather than the
 * plugin's 30m default: a shorter code lifetime is a smaller phishing window
 * (device code's residual risk, ADR Q0b), and fifteen minutes is ample to open a
 * browser, sign in, and approve.
 */
export const DEVICE_CODE_EXPIRES_IN = '15m';

/** Minimum poll spacing the CLI is told to honour; polling faster answers
 * `slow_down`. The plugin's default, pinned so the AC is visible in review. */
export const DEVICE_CODE_POLL_INTERVAL = '5s';

/** Where the human completes the grant. Relative, so the plugin resolves it
 * against Better-Auth's `baseURL` chain and a preview deployment prints its own
 * URL. The page itself is Subtask MOTIR-1867. */
export const DEVICE_VERIFICATION_PATH = '/device';

/**
 * How long a device-minted PAT lives (ADR Q3). 90 days is the same recommended
 * default the settings create-modal opens on, so the two mint paths agree and there
 * is one number to document. Not `never` — an unattended credential on a box you
 * may not still own is precisely the one that should age out. Not offered as a
 * choice on the approval screen (fewer controls on the phishable surface).
 */
export const CLI_TOKEN_EXPIRY_DAYS = 90;

/** The label prefix that makes a device-minted token recognisable in Settings →
 * Account → API tokens, so "disconnect that machine" is an obvious action. */
const CLI_TOKEN_LABEL_PREFIX = 'CLI · ';

/** Shown when the CLI reports no usable hostname — the label must still say what
 * kind of credential this is. */
const UNKNOWN_HOSTNAME = 'unknown host';

/** `apiTokensService.normalizeLabel`'s cap. Exceeding it throws
 * InvalidApiTokenLabelError, so the hostname is trimmed to fit BEFORE the mint
 * rather than failing an otherwise-valid approval. */
const MAX_LABEL_LENGTH = 100;

/**
 * Normalise a CLI-reported hostname for storage: trimmed, capped, and never empty.
 * Display-only and never interpreted (ADR Q4), so the only requirements are that it
 * is bounded and that it round-trips into a valid token label.
 */
export function normalizeHostname(hostname: string | null | undefined): string {
  const trimmed = (hostname ?? '').trim();
  if (trimmed.length === 0) return UNKNOWN_HOSTNAME;
  return trimmed.slice(0, MAX_LABEL_LENGTH - CLI_TOKEN_LABEL_PREFIX.length);
}

/**
 * The token label for a grant approved from `hostname` — `CLI · workbox`. Bounded
 * by construction: `normalizeHostname` already reserves room for the prefix, so the
 * result always satisfies the service's 100-char limit.
 */
export function cliTokenLabel(hostname: string | null | undefined): string {
  return CLI_TOKEN_LABEL_PREFIX + normalizeHostname(hostname);
}
