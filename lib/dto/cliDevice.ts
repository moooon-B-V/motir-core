// DTOs for the CLI device-authorization surface (Story MOTIR-1863 · Subtask
// MOTIR-1865) — what crosses `/api/cli/device/*` to `packages/cli` and to the
// `/device` page (Subtask MOTIR-1867).
//
// The FIELD NAMES ARE snake_case ON PURPOSE, unlike every other Motir DTO: these
// two shapes are RFC 8628 §3.2 / §3.4 payloads, so a standard device-flow poller
// works against Motir unchanged and the CLI's branch is the standard one. Deviating
// to camelCase here would buy internal consistency and cost interoperability.

/**
 * The grant, as `POST /api/cli/device/start` hands it to the terminal. Everything
 * the CLI needs to print instructions and start polling — and nothing about the
 * user, who has not been identified yet.
 */
export interface DeviceGrantStartDTO {
  /** The CLI's polling credential. High-entropy, never shown to the human. */
  device_code: string;
  /** The short code the human reads out and types (8 chars, no `0/O/1/I/L`). */
  user_code: string;
  /** Where the human goes to approve. Absolute, resolved against Better-Auth's
   * `baseURL`, so a preview deployment prints its own URL. */
  verification_uri: string;
  /** The same URL with `?user_code=…` pre-filled — what the CLI opens in a browser
   * when it can, and prints either way. */
  verification_uri_complete: string;
  /** Seconds until the codes expire (900 — the ADR's 15m). */
  expires_in: number;
  /** Minimum seconds between polls; polling faster answers `slow_down`. */
  interval: number;
}

/**
 * The successful poll — the ONE place a device-minted PAT's plaintext ever exists.
 *
 * `user` and `workspace` are Motir additions to the RFC shape so `motir login` can
 * print the same `Logged in as … (workspace …)` confirmation `motir auth login`
 * prints today WITHOUT a second `whoami` round trip. The device path skips the
 * connect + `listToolNames` validation the paste path performs: a server-minted
 * token cannot be the wrong token.
 */
export interface DeviceGrantTokenDTO {
  /** The `motir_pat_…` plaintext. Returned exactly once — the grant row is deleted
   * in the same transaction that claims it, so a second poll cannot re-issue it. */
  access_token: string;
  token_type: 'Bearer';
  /** The granted scopes, space-separated (`CLI_TOKEN_SCOPES`). Fixed — the approval
   * screen shows them and cannot change them. */
  scope: string;
  /** Seconds until the PAT expires (90 days). */
  expires_in: number;
  user: { id: string; name: string; email: string };
  workspace: { id: string; name: string; slug: string };
}
