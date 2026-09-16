// ONE MEMBER OF AN APPROVE-AND-MERGE SET, READ BACK OUT OF ITS VERSION (Story MOTIR-4909 ·
// MOTIR-5484; `approval-gates.md` §8's amendment, decision 2).
//
// A `pull_request_approval` gate's `subjectVersion` is its members' versions, sorted and
// comma-joined, each spelled `owner/name#number@headSha` — the spelling the retired
// per-pull-request kind used for its one pull request, kept because it is the one the
// merge entry point still compares against. The Development frame names
// each member from it (the consequence line, the confirm step, the refusal) and matches it
// to a row and to the head that row is at now.
//
// ⚠️ CLIENT-SAFE, AND IMPORTING NOTHING. The frame is a client component, and the module
// that WRITES these versions (`deliverySetVersion.ts`) reaches the merge handler; reading
// one back needs none of that.

/** One member of an approve-and-merge set, parsed. */
export interface MemberVersion {
  /** The member exactly as the approval named it. */
  subjectVersion: string;
  /** `owner/name`. */
  repo: string;
  number: number;
  /** The commit the approval was asked about. */
  headSha: string;
}

/** Parse one `owner/name#number@headSha`; `null` for anything not spelled that way. */
export function parseMemberVersion(subjectVersion: string): MemberVersion | null {
  const at = subjectVersion.lastIndexOf('@');
  if (at <= 0) return null;
  const hash = subjectVersion.lastIndexOf('#', at);
  if (hash <= 0) return null;
  const number = Number(subjectVersion.slice(hash + 1, at));
  const headSha = subjectVersion.slice(at + 1);
  if (!Number.isInteger(number) || number <= 0 || headSha.length === 0) return null;
  return { subjectVersion, repo: subjectVersion.slice(0, hash), number, headSha };
}

/** Every member of a set version, in the set's own (canonical) order. A malformed member is
 *  skipped rather than guessed at; a null version is an empty set. */
export function membersOf(setVersion: string | null): MemberVersion[] {
  return (setVersion ?? '')
    .split(',')
    .filter(Boolean)
    .flatMap((version) => {
      const member = parseMemberVersion(version);
      return member ? [member] : [];
    });
}
