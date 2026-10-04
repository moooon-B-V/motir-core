import { createHash } from 'node:crypto';

/**
 * The platform audit log's HASH CHAIN — MOTIR-751 (Story 10.3).
 *
 * `platform_audit_log` was append-only by CONVENTION (the repository exposes no
 * mutator). This file is what makes it tamper-EVIDENT: every row carries
 *
 *     entryHash = SHA-256( canonical( version, seq, createdAt, actor, actorRole,
 *                                     action, target, organizationId, reason,
 *                                     metadata, prevHash ) )
 *
 * and `prevHash` is the previous row's `entryHash`. Altering any field of a past
 * row makes that row's hash wrong; re-computing its hash to hide the edit breaks
 * the NEXT row's link; deleting a row leaves a gap in `seq`. Each of the three is
 * reported by `findFirstChainBreak`, at the first entry it affects, and every
 * entry after that one is no longer vouched for.
 *
 * ── THE ALGORITHM DECISION: plain SHA-256, not HMAC ──────────────────────────
 *
 * SHA-256 with no key, deliberately. Verification then needs NO SECRET: anyone
 * holding a copy of the rows — an auditor, a restored backup, a second Postgres
 * running `platform_audit_entry_hash()` — can recompute the chain, and there is no
 * key whose loss, rotation or leak changes what the log proves. The trade is the
 * known one: somebody with WRITE access to the table can rewrite a suffix of the
 * chain and re-hash it consistently. Detecting THAT needs something outside the
 * database to hold a hash the attacker cannot reach — an HMAC key held outside the
 * DB, or periodically ANCHORING the head hash somewhere external (a signed
 * timestamp, a write-once bucket, a ticket). Both are DEFERRED HARDENING, not
 * part of this card; the chain is shaped so either can be added later without a
 * re-hash (an anchor records `(seq, entryHash)` of the head as it stood).
 *
 * The same reason bounds what TRUNCATION can be detected: deleting the newest
 * rows leaves a shorter chain that verifies. The anchor above is the answer to
 * that too.
 *
 * ── THE CANONICAL FORM (v1) — and why it is spelled out ──────────────────────
 *
 * The hash is over a JSON ARRAY, serialised with sorted object keys and no
 * whitespace (`canonicalJson`). It is reproduced EXACTLY in SQL by
 * `platform_audit_canonical_json(jsonb)` / `platform_audit_entry_hash(...)`, which
 * the migration used to chain the rows that existed before this card and which
 * `tests/platform/platformAuditChain.test.ts` holds to byte-equality with this
 * file. Change one and not the other and that test fails. To change the form,
 * bump `AUDIT_CHAIN_VERSION` — never edit v1 in place: every row already written
 * was hashed with it.
 *
 * Known, accepted edges of the SQL mirror (none reachable by the code-owned
 * vocabulary's metadata, which is strings and nulls):
 *   - a JSON NUMBER outside [1e-6, 1e21) prints in exponent form in JavaScript
 *     and in positional form in Postgres. The TS side is self-consistent (a
 *     number round-trips through `jsonb` to the same double), so only a SQL-side
 *     recomputation would disagree.
 *   - object keys sort by UTF-16 code unit here and by UTF-8 byte in SQL
 *     (`COLLATE "C"`); they differ only for keys mixing astral characters with
 *     U+E000–U+FFFF.
 *
 * Pure: no I/O, no `server-only`, so the page (MOTIR-752) can import the status
 * helper at the bottom and tests can import all of it.
 */

/** The version tag that leads every hashed array. Bump it to change the form. */
export const AUDIT_CHAIN_VERSION = 'motir.platform_audit.v1';

/** The fields the hash covers — every stored column except `id` and the hash itself. */
export interface AuditChainFields {
  seq: number;
  createdAt: Date;
  actorUserId: string;
  actorRole: string;
  action: string;
  targetKind: string;
  targetId: string | null;
  targetLabel: string | null;
  organizationId: string | null;
  reason: string | null;
  /** The JSON as STORED (read back), or the input about to be stored. `null` / `undefined` → none. */
  metadata: unknown;
  /** The previous entry's `entryHash`, or `null` for entry #1. */
  prevHash: string | null;
}

/** A stored row, as the verifier needs it. */
export interface AuditChainRow extends AuditChainFields {
  entryHash: string;
}

/**
 * Deterministic JSON: object keys sorted, no whitespace, `undefined` members
 * dropped (as `JSON.stringify` drops them, which is what Prisma sends).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Normalise a metadata INPUT to what the database will hand back: exactly the
 * JSON Prisma serialises. Used on the write side so the hash covers the stored
 * value, not an in-memory object that might carry a `toJSON` or an `undefined`.
 */
export function normaliseAuditMetadata(metadata: unknown): unknown {
  if (metadata === undefined || metadata === null) return null;
  return JSON.parse(JSON.stringify(metadata)) as unknown;
}

/** The exact string the hash is computed over. Exported for the SQL parity test. */
export function auditChainPreimage(f: AuditChainFields): string {
  return canonicalJson([
    AUDIT_CHAIN_VERSION,
    f.seq,
    f.createdAt.toISOString(),
    f.actorUserId,
    f.actorRole,
    f.action,
    f.targetKind,
    f.targetId,
    f.targetLabel,
    f.organizationId,
    f.reason,
    normaliseAuditMetadata(f.metadata),
    f.prevHash,
  ]);
}

/** SHA-256, lowercase hex, over the UTF-8 bytes of the canonical preimage. */
export function computeAuditEntryHash(f: AuditChainFields): string {
  return createHash('sha256').update(auditChainPreimage(f), 'utf8').digest('hex');
}

/**
 * Why the chain stopped verifying at an entry:
 *   - `hash_mismatch` — the entry's content no longer produces its stored hash
 *     (it, or its stored `prevHash`, was changed after it was written);
 *   - `link_mismatch` — its `prevHash` is not the previous entry's stored hash
 *     (the previous entry was changed AND re-hashed, or replaced);
 *   - `seq_gap` — the entry before it is missing (deleted), or entry #1 is.
 */
export type AuditChainBreakReason = 'hash_mismatch' | 'link_mismatch' | 'seq_gap';

export interface AuditChainBreak {
  seq: number;
  createdAt: Date;
  reason: AuditChainBreakReason;
}

/**
 * Where a walk starts. `genesis` — the first row must be entry #1 with no
 * `prevHash`. `{ seq, entryHash }` — the stored row just before this batch (the
 * last row of the previous batch, or a range's anchor).
 */
export type AuditChainCursor = 'genesis' | { seq: number; entryHash: string };

/**
 * Walk `rows` (ascending `seq`) from `cursor` and return the FIRST break, or
 * `null` when every row verifies. Pure, so the service can feed it in batches:
 * pass the last row of one batch as the next batch's cursor.
 *
 * The hash is checked first: an entry whose own content changed is reported as
 * `hash_mismatch` even though its link may also be wrong.
 */
export function findFirstChainBreak(
  rows: readonly AuditChainRow[],
  cursor: AuditChainCursor,
): AuditChainBreak | null {
  let prev = cursor;
  for (const row of rows) {
    const at = { seq: row.seq, createdAt: row.createdAt };
    if (computeAuditEntryHash(row) !== row.entryHash) return { ...at, reason: 'hash_mismatch' };
    if (prev === 'genesis') {
      if (row.seq !== 1) return { ...at, reason: 'seq_gap' };
      if (row.prevHash !== null) return { ...at, reason: 'link_mismatch' };
    } else {
      if (row.seq !== prev.seq + 1) return { ...at, reason: 'seq_gap' };
      if (row.prevHash !== prev.entryHash) return { ...at, reason: 'link_mismatch' };
    }
    prev = { seq: row.seq, entryHash: row.entryHash };
  }
  return null;
}

/** What one verification established — the shape `verifyChain` returns (minus ISO dates). */
export type AuditChainVerdict =
  | { status: 'ok'; fromSeq: number; throughSeq: number | null }
  | { status: 'broken'; fromSeq: number; throughSeq: number | null; brokenAtSeq: number };

/**
 * How ONE entry reads against a verification — the design's Panel 6/7 row
 * marker. `verified` inside a range that checked out; `mismatch` for the first
 * broken entry ("Hash mismatch"); `unverified` for everything after it, and for
 * anything outside the range the verification covered ("Unverified").
 */
export function auditEntryChainStatus(
  seq: number,
  verdict: AuditChainVerdict,
): 'verified' | 'mismatch' | 'unverified' {
  if (seq < verdict.fromSeq) return 'unverified';
  if (verdict.status === 'broken') {
    if (seq === verdict.brokenAtSeq) return 'mismatch';
    return seq < verdict.brokenAtSeq ? 'verified' : 'unverified';
  }
  return verdict.throughSeq !== null && seq <= verdict.throughSeq ? 'verified' : 'unverified';
}
