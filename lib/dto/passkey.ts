// DTO for the account passkeys surface (Story MOTIR-1214 · Subtask MOTIR-3611)
// — what crosses into the Security pane's passkeys section (MOTIR-3612).
//
// NOTHING FROM THE CREDENTIAL CROSSES, and unlike `lib/dto/twoFactor.ts` there
// is no once-only exception: `publicKey`, `credentialID`, `counter`,
// `transports` and `aaguid` all stay server-side. None of them is a secret —
// the private half never leaves the user's authenticator, which is the whole
// security property of a passkey — but none of them is renderable either. The
// pane's job is to let a person tell their laptop from their phone and remove
// the one they lost, and every field below serves exactly that.

/**
 * One registered passkey, as the Security pane sees it.
 *
 * Ordered by `createdAt` at the repository, so "the one I added first" is the
 * first row — the only ordering a person can predict without a label.
 */
export interface PasskeyDTO {
  /** The row id — what a rename or a remove addresses. Opaque to the reader. */
  id: string;
  /**
   * The label the owner gave it. NULLABLE: the plugin's `name` is optional and
   * a registration may supply none, so the pane owns the fallback rather than
   * the mapper inventing one. (A server-side default would also be wrong — it
   * would make an unnamed row indistinguishable from one a person named.)
   */
  name: string | null;
  /**
   * SimpleWebAuthn's `CredentialDeviceType` — `singleDevice` or `multiDevice`.
   * This is the field that answers the question people actually have about a
   * passkey they are looking at: is this only on this machine, or is it synced?
   */
  deviceType: string;
  /** Whether the platform backs the credential up (iCloud / Google-synced). */
  backedUp: boolean;
  /**
   * When it was registered, as an ISO string rather than a `Date`. This shape
   * is serialised into a Server Component's props and a `Date` does not survive
   * that trip — the reason `toTrustedDeviceDTO` already gives.
   */
  createdAt: string;
}
