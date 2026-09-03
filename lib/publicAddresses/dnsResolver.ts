// THE DNS PORT — Story MOTIR-3878 · Subtask MOTIR-4216.
//
// Ownership of a customer domain is proven by a `TXT` record the customer
// creates (the ADR §5), so verifying one means reading public DNS — a second
// system an automated lane cannot reach and cannot control.
//
// It is a PORT for the same reason the certificate provider is one, and the
// reason is not symmetry: without an injectable resolver the E2E card
// (MOTIR-4225) cannot drive a domain to `issued` at all. It would then either
// pass vacuously — asserting the states it CAN reach and quietly not the ones it
// cannot — or stub the API inside the browser, which tests the stub. Both are
// the failure `plan-rules/type-test.md`'s tell (d) names.

/** Reads public DNS. One method, because one question is asked. */
export interface DnsResolver {
  /**
   * Every `TXT` record at `name`, flattened.
   *
   * A `TXT` record is a LIST OF STRINGS at the protocol level — a long value
   * arrives split into 255-byte chunks — and every resolver hands them back as
   * an array of arrays for that reason. Implementations JOIN each record's
   * chunks before returning, so a caller compares whole values and a token that
   * happens to cross the chunk boundary does not silently fail to match.
   *
   * Returns `[]` for a name that does not exist. NXDOMAIN is not an error here:
   * "the customer has not created the record yet" is the ordinary state this
   * exists to observe, and making it throw would make the common path the
   * exceptional one.
   */
  resolveTxt(name: string): Promise<string[]>;
}

/** The production binding — Node's own resolver. */
export const nodeDnsResolver: DnsResolver = {
  async resolveTxt(name: string): Promise<string[]> {
    // Imported lazily so this module can be loaded in an environment with no
    // `node:dns` (an edge bundle, a browser-side type import) without the
    // import itself failing.
    const { resolveTxt } = await import('node:dns/promises');
    try {
      const records = await resolveTxt(name);
      return records.map((chunks) => chunks.join(''));
    } catch (err) {
      // ENOTFOUND / ENODATA mean the name or the record type is absent, which is
      // the "not created yet" state. Anything else — SERVFAIL, a timeout — is a
      // real lookup failure and must NOT be reported as "no record", because
      // that would tell a customer their correct record is missing.
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw err;
    }
  },
};
